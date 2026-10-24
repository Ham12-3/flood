"""Export a trained NeuralHydrology run to ONNX plus a JSON sidecar for serving.

The API serves with onnxruntime only (no torch). The sidecar carries everything needed
to rebuild inputs and undo the scaling: feature order, centres and scales, sequence
length, plus held-out skill and an empirical error band per lead time.
"""

import json
from pathlib import Path
from typing import Any

import numpy as np

from floodscope_ml.features import DYNAMIC_INPUTS, LEADS, TARGETS

ONNX_NAME = "forecast_lstm.onnx"
META_NAME = "forecast_lstm.json"


def _latest_weights(run_dir: Path) -> Path:
    weights = sorted(run_dir.glob("model_epoch*.pt"))
    if not weights:
        raise FileNotFoundError(f"No model_epoch*.pt in {run_dir}")
    return weights[-1]


def _scaler_values(
    scaler: dict[str, Any], names: tuple[str, ...]
) -> tuple[list[float], list[float]]:
    centre = scaler["xarray_feature_center"]
    scale = scaler["xarray_feature_scale"]
    return (
        [float(centre[n].values) for n in names],
        [float(scale[n].values) for n in names],
    )


def export_run(
    run_dir: Path,
    out_dir: Path,
    evaluation: dict[str, Any] | None = None,
    training_info: dict[str, Any] | None = None,
) -> tuple[Path, Path]:
    import torch
    from neuralhydrology.datautils.utils import load_scaler
    from neuralhydrology.modelzoo import get_model
    from neuralhydrology.utils.config import Config

    cfg = Config(run_dir / "config.yml")
    if tuple(cfg.dynamic_inputs) != DYNAMIC_INPUTS or tuple(cfg.target_variables) != TARGETS:
        raise ValueError(
            "Run was trained with different inputs/targets than floodscope_ml.features"
        )
    model = get_model(cfg)
    model.load_state_dict(torch.load(_latest_weights(run_dir), map_location="cpu"))
    model.eval()

    class Wrapper(torch.nn.Module):
        """Takes one [batch, time, features] tensor; returns scaled predictions at the last step."""

        def __init__(self, inner: torch.nn.Module) -> None:
            super().__init__()
            self.inner = inner

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            x_d = {name: x[:, :, i : i + 1] for i, name in enumerate(DYNAMIC_INPUTS)}
            y: torch.Tensor = self.inner({"x_d": x_d})["y_hat"][:, -1, :]
            return y

    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / ONNX_NAME
    dummy = torch.zeros(1, cfg.seq_length, len(DYNAMIC_INPUTS))
    torch.onnx.export(
        Wrapper(model),
        (dummy,),
        str(onnx_path),
        input_names=["x"],
        output_names=["y"],
        dynamic_axes={"x": {0: "batch"}, "y": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )

    scaler = load_scaler(run_dir)
    in_centre, in_scale = _scaler_values(scaler, DYNAMIC_INPUTS)
    out_centre, out_scale = _scaler_values(scaler, TARGETS)
    meta = {
        "format": 1,
        "inputs": list(DYNAMIC_INPUTS),
        "targets": list(TARGETS),
        "leads": LEADS,
        "seq_length": int(cfg.seq_length),
        "input_centre": in_centre,
        "input_scale": in_scale,
        "target_centre": out_centre,
        "target_scale": out_scale,
        "run": run_dir.name,
        "training": training_info or {},
        "evaluation": evaluation or {},
    }
    meta_path = out_dir / META_NAME
    meta_path.write_text(json.dumps(meta, indent=2))
    return onnx_path, meta_path


def nh_reference_prediction(run_dir: Path, x: np.ndarray) -> np.ndarray:
    """Unscaled q_ratio predictions from NeuralHydrology itself, for checking the export."""
    import torch
    from neuralhydrology.datautils.utils import load_scaler
    from neuralhydrology.modelzoo import get_model
    from neuralhydrology.utils.config import Config

    cfg = Config(run_dir / "config.yml")
    model = get_model(cfg)
    model.load_state_dict(torch.load(_latest_weights(run_dir), map_location="cpu"))
    model.eval()
    scaler = load_scaler(run_dir)
    in_c, in_s = _scaler_values(scaler, DYNAMIC_INPUTS)
    out_c, out_s = _scaler_values(scaler, TARGETS)
    xs = (x - np.array(in_c)) / np.array(in_s)
    t = torch.from_numpy(xs.astype("float32"))
    with torch.no_grad():
        y = model({"x_d": {n: t[:, :, i : i + 1] for i, n in enumerate(DYNAMIC_INPUTS)}})["y_hat"]
    out: np.ndarray = y[:, -1, :].numpy() * np.array(out_s) + np.array(out_c)
    return out
