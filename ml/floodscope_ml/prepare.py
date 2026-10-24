"""Convert Caravan (netCDF release) into a NeuralHydrology "generic" dataset.

    python -m floodscope_ml.prepare --caravan-dir /content/Caravan --out-dir /content/prepared \
        --subdatasets camels camelsgb camelsaus lamah --test-fraction 0.2

Writes out-dir/time_series/<basin>.nc with the model inputs and targets from
floodscope_ml.features, out-dir/attributes/flow.csv (each basin's mean flow) and
train_basins.txt / test_basins.txt. Test basins are held out entirely.
"""

import argparse
import random
from pathlib import Path

import pandas as pd

from floodscope_ml.features import FORCINGS, add_derived

MEAN_FLOW_START = "1990-10-01"
MEAN_FLOW_END = "2010-09-30"  # the training period, so test basins never leak future info


def basins_in(caravan_dir: Path, subdataset: str) -> list[str]:
    folder = caravan_dir / "timeseries" / "netcdf" / subdataset
    if not folder.exists():
        raise FileNotFoundError(f"No Caravan time series at {folder}")
    return sorted(p.stem for p in folder.glob("*.nc"))


def load_basin(caravan_dir: Path, basin: str) -> pd.DataFrame:
    # NeuralHydrology's own Caravan reader, so the layout matches the published dataset.
    from neuralhydrology.datasetzoo.caravan import load_caravan_timeseries

    return load_caravan_timeseries(data_dir=caravan_dir, basin=basin)


def check_variables(df: pd.DataFrame, basin: str) -> None:
    needed = [f.caravan for f in FORCINGS] + ["streamflow"]
    missing = [v for v in needed if v not in df.columns]
    if missing:
        raise KeyError(
            f"Basin {basin} lacks {missing}. Available variables: {sorted(df.columns)}. "
            "Update FORCINGS in floodscope_ml/features.py to match this Caravan release."
        )


def prepare_basin(df: pd.DataFrame, basin: str) -> tuple[pd.DataFrame, float] | None:
    check_variables(df, basin)
    flow = df["streamflow"]
    period = flow.loc[MEAN_FLOW_START:MEAN_FLOW_END]
    if period.count() < 365 * 5:
        return None  # too little flow record to define a mean
    mean_flow = float(period.mean())
    if not mean_flow > 0:
        return None
    return add_derived(df, flow, mean_flow), mean_flow


def split_basins(basins: list[str], test_fraction: float, seed: int) -> tuple[list[str], list[str]]:
    shuffled = sorted(basins)
    random.Random(seed).shuffle(shuffled)
    n_test = round(len(shuffled) * test_fraction)
    return sorted(shuffled[n_test:]), sorted(shuffled[:n_test])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--caravan-dir", type=Path, required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument(
        "--subdatasets", nargs="+", default=["camels", "camelsgb", "camelsaus", "lamah"]
    )
    ap.add_argument("--test-fraction", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    ts_dir = args.out_dir / "time_series"
    ts_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "attributes").mkdir(exist_ok=True)
    kept: dict[str, float] = {}
    for sub in args.subdatasets:
        basins = basins_in(args.caravan_dir, sub)
        print(f"{sub}: {len(basins)} basins")
        for basin in basins:
            prepared = prepare_basin(load_basin(args.caravan_dir, basin), basin)
            if prepared is None:
                continue
            frame, mean_flow = prepared
            frame.rename_axis("date").to_xarray().to_netcdf(ts_dir / f"{basin}.nc")
            kept[basin] = mean_flow

    pd.Series(kept, name="mean_flow_mm_per_day").rename_axis("gauge_id").to_csv(
        args.out_dir / "attributes" / "flow.csv"
    )
    train, test = split_basins(list(kept), args.test_fraction, args.seed)
    (args.out_dir / "train_basins.txt").write_text("\n".join(train) + "\n")
    (args.out_dir / "test_basins.txt").write_text("\n".join(test) + "\n")
    print(f"Prepared {len(kept)} basins: {len(train)} train, {len(test)} held-out test")


if __name__ == "__main__":
    main()
