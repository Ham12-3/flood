"""Build a tiny ONNX model on synthetic data, for API tests only. Never serve it.

uv run python scripts/make_test_model.py ../api/tests/fixtures/test_model
"""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests"))

from test_pipeline import synthetic_basin

from floodscope_ml.export import META_NAME, export_run
from floodscope_ml.features import LEADS, add_derived
from floodscope_ml.train import train, write_config

out = Path(sys.argv[1])
work = Path(tempfile.mkdtemp())
data = work / "prepared"
(data / "time_series").mkdir(parents=True)
basins = [f"syn_{i}" for i in range(3)]
for i, b in enumerate(basins):
    df = synthetic_basin(i)
    add_derived(df, df["streamflow"], float(df["streamflow"].mean())).rename_axis(
        "date"
    ).to_xarray().to_netcdf(data / "time_series" / f"{b}.nc")
(data / "train_basins.txt").write_text("\n".join(basins) + "\n")
(data / "test_basins.txt").write_text(basins[0] + "\n")
cfg = write_config(
    data,
    work / "runs",
    work / "config.yml",
    overrides={
        "train_start_date": "01/01/1990",
        "train_end_date": "31/12/1993",
        "validation_start_date": "01/01/1994",
        "validation_end_date": "31/12/1994",
        "test_start_date": "01/01/1995",
        "test_end_date": "30/11/1996",
        "epochs": 1,
        "seq_length": 30,
        "hidden_size": 8,
        "batch_size": 64,
        "device": "cpu",
        "num_workers": 0,
        "validate_every": 5,
        "save_weights_every": 1,
        "learning_rate": {0: 1e-3},
    },
)
run = train(cfg)
export_run(
    run,
    out,
    evaluation={"log_ratio_quantiles": [[-0.3, 0.3]] * LEADS, "note": "SYNTHETIC TEST MODEL"},
    training_info={"dataset": "synthetic test fixture - not a real model"},
)
meta = json.loads((out / META_NAME).read_text())
print("wrote", out, "seq_length", meta["seq_length"])
