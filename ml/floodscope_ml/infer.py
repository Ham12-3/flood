"""Serve the exported forecast model with onnxruntime only (no torch)."""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from floodscope_ml.export import META_NAME, ONNX_NAME
from floodscope_ml.features import DYNAMIC_INPUTS


class ModelUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class Forecast:
    q_ratio: np.ndarray  # shape (leads,)
    low: np.ndarray | None  # empirical band from held-out errors, same shape
    high: np.ndarray | None


class ForecastModel:
    def __init__(self, model_dir: Path) -> None:
        onnx_path = model_dir / ONNX_NAME
        meta_path = model_dir / META_NAME
        if not onnx_path.exists() or not meta_path.exists():
            raise ModelUnavailable(
                f"No trained model in {model_dir}. Train it with ml/notebooks/train_colab.ipynb "
                f"and copy {ONNX_NAME} and {META_NAME} there."
            )
        import onnxruntime as ort

        self.meta: dict[str, Any] = json.loads(meta_path.read_text())
        if list(self.meta["inputs"]) != list(DYNAMIC_INPUTS):
            raise ModelUnavailable("Model inputs do not match this version of floodscope_ml")
        self.session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        self.seq_length = int(self.meta["seq_length"])
        self.leads = int(self.meta["leads"])
        self._in_c = np.array(self.meta["input_centre"], dtype="float32")
        self._in_s = np.array(self.meta["input_scale"], dtype="float32")
        self._out_c = np.array(self.meta["target_centre"], dtype="float32")
        self._out_s = np.array(self.meta["target_scale"], dtype="float32")

    def predict(self, frame: pd.DataFrame) -> Forecast:
        """`frame` from features.serving_frame; uses its last `seq_length` rows."""
        if len(frame) < self.seq_length:
            raise ValueError(f"Need {self.seq_length} days of inputs, got {len(frame)}")
        x = frame[list(DYNAMIC_INPUTS)].to_numpy(dtype="float32")[-self.seq_length :]
        if not np.isfinite(x).all():
            bad = [
                c
                for c in DYNAMIC_INPUTS
                if not np.isfinite(frame[c].to_numpy()[-self.seq_length :]).all()
            ]
            raise ValueError(f"Inputs contain gaps: {bad}")
        xs = ((x - self._in_c) / self._in_s)[None, :, :]
        (y,) = self.session.run(["y"], {"x": xs.astype("float32")})
        q = np.maximum(y[0] * self._out_s + self._out_c, 0.0)
        band = self.meta.get("evaluation", {}).get("log_ratio_quantiles")
        if band and len(band) == self.leads:
            lo = np.array([b[0] for b in band], dtype="float64")
            hi = np.array([b[1] for b in band], dtype="float64")
            return Forecast(q, q * np.exp(lo), q * np.exp(hi))
        return Forecast(q, None, None)
