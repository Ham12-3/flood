"""Fill the config template and run NeuralHydrology training (in Colab, on a GPU)."""

from pathlib import Path

import yaml

from floodscope_ml.features import DYNAMIC_INPUTS, TARGETS

CONFIG_TEMPLATE = Path(__file__).resolve().parent.parent / "configs" / "forecast_lstm.yml"


def write_config(
    prepared_dir: Path,
    run_dir: Path,
    out_path: Path,
    overrides: dict[str, object] | None = None,
) -> Path:
    cfg = yaml.safe_load(CONFIG_TEMPLATE.read_text())
    cfg.update(
        data_dir=str(prepared_dir),
        run_dir=str(run_dir),
        train_basin_file=str(prepared_dir / "train_basins.txt"),
        validation_basin_file=str(prepared_dir / "train_basins.txt"),
        test_basin_file=str(prepared_dir / "test_basins.txt"),
        dynamic_inputs=list(DYNAMIC_INPUTS),
        target_variables=list(TARGETS),
    )
    cfg.update(overrides or {})
    out_path.write_text(yaml.safe_dump(cfg, sort_keys=False))
    return out_path


def train(config_path: Path) -> Path:
    """Train and return the run directory."""
    from neuralhydrology.nh_run import start_run

    start_run(config_file=config_path)
    cfg = yaml.safe_load(config_path.read_text())
    runs = sorted(Path(cfg["run_dir"]).glob(f"{cfg['experiment_name']}_*"))
    if not runs:
        raise FileNotFoundError("Training finished but no run directory was found")
    return runs[-1]
