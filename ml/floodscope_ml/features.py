"""Model inputs and targets, shared by training (Caravan) and serving (Open-Meteo).

The model forecasts river flow 1-7 days ahead as a ratio to the river's long-term mean
flow ("q_ratio"). That keeps it unit-free: Caravan streamflow is in mm/day (needs the
catchment area to convert), while at serving time we know a GloFAS cell's flow in m3/s
but not its catchment. Multiplying the forecast ratio by the GloFAS cell's own mean
turns it back into m3/s.

Inputs on each day t:
- weather and soil on day t (Caravan ERA5-Land basin means / Open-Meteo at the point),
- precipitation and temperature for t+1..t+7 (known from a weather forecast when serving),
- q_ratio on day t (observed in training, GloFAS-simulated when serving). Gaps of up to
  two days are filled; longer gaps stay NaN, so NeuralHydrology skips those samples.
  (A 0/1 "missing" flag would be constant in gap-free data, and NeuralHydrology's
  standardisation divides by its zero spread.)
Targets: q_ratio on days t+1..t+7.
"""

from dataclasses import dataclass

import numpy as np
import pandas as pd

LEADS = 7
MAX_GAP_FILL_DAYS = 2


@dataclass(frozen=True)
class Forcing:
    caravan: str  # variable name in Caravan's ERA5-Land time series
    open_meteo: str  # daily variable name in the Open-Meteo archive / forecast APIs
    unit: str


# Caravan names follow its _mean/_min/_max/_sum convention. prepare.py checks every one
# against the real files and stops with the list of available variables if one is wrong.
FORCINGS: tuple[Forcing, ...] = (
    Forcing("total_precipitation_sum", "precipitation_sum", "mm/day"),
    Forcing("temperature_2m_mean", "temperature_2m_mean", "degC"),
    Forcing("temperature_2m_min", "temperature_2m_min", "degC"),
    Forcing("temperature_2m_max", "temperature_2m_max", "degC"),
    # Caravan computes PET with FAO-56 Penman-Monteith, the same method as Open-Meteo's ET0.
    Forcing("potential_evaporation_sum", "et0_fao_evapotranspiration", "mm/day"),
    Forcing("volumetric_soil_water_layer_1_mean", "soil_moisture_0_to_7cm_mean", "m3/m3"),
    Forcing("volumetric_soil_water_layer_2_mean", "soil_moisture_7_to_28cm_mean", "m3/m3"),
    Forcing("volumetric_soil_water_layer_3_mean", "soil_moisture_28_to_100cm_mean", "m3/m3"),
    Forcing("volumetric_soil_water_layer_4_mean", "soil_moisture_100_to_255cm_mean", "m3/m3"),
)

LEAD_SOURCES = ("total_precipitation_sum", "temperature_2m_mean")
FLOW = "q_ratio"


def lead_name(var: str, lead: int) -> str:
    return f"{var}_lead{lead}"


def target_name(lead: int) -> str:
    return f"{FLOW}_lead{lead}"


DYNAMIC_INPUTS: tuple[str, ...] = (
    *(f.caravan for f in FORCINGS),
    *(lead_name(v, k) for v in LEAD_SOURCES for k in range(1, LEADS + 1)),
    FLOW,
)
TARGETS: tuple[str, ...] = tuple(target_name(k) for k in range(1, LEADS + 1))


def flow_ratio(flow: pd.Series, mean_flow: float) -> pd.Series:
    if not mean_flow > 0:
        raise ValueError("Mean flow must be positive to form a flow ratio")
    return flow / mean_flow


def add_derived(df: pd.DataFrame, flow: pd.Series, mean_flow: float) -> pd.DataFrame:
    """Add lead forcings, the flow-ratio input (gaps up to 2 days filled) and the targets.

    `df` holds the forcings on a daily DatetimeIndex; `flow` is daily flow on the same
    index in any unit, as long as `mean_flow` uses the same unit.
    """
    missing = [f.caravan for f in FORCINGS if f.caravan not in df.columns]
    if missing:
        raise KeyError(f"Missing forcing columns: {missing}")
    out = df[[f.caravan for f in FORCINGS]].copy()
    for var in LEAD_SOURCES:
        for k in range(1, LEADS + 1):
            out[lead_name(var, k)] = df[var].shift(-k)
    q = flow_ratio(flow.reindex(df.index), mean_flow)
    out[FLOW] = q.ffill(limit=MAX_GAP_FILL_DAYS)
    for k in range(1, LEADS + 1):
        out[target_name(k)] = q.shift(-k)  # NaN targets are skipped by the loss
    return out.astype("float32")


def serving_frame(
    weather: pd.DataFrame, glofas_flow: pd.Series, glofas_mean: float, issue_date: pd.Timestamp
) -> pd.DataFrame:
    """Build model inputs from Open-Meteo data, ending on `issue_date`.

    `weather` has Open-Meteo daily columns indexed by date, covering the history window
    and the 7 forecast days after `issue_date`; `glofas_flow` is GloFAS discharge (m3/s).
    """
    renamed = weather.rename(columns={f.open_meteo: f.caravan for f in FORCINGS})
    frame = add_derived(renamed, glofas_flow, glofas_mean)
    return frame.loc[:issue_date, list(DYNAMIC_INPUTS)]


def finite_rows(frame: pd.DataFrame) -> pd.Series:
    return pd.Series(np.isfinite(frame.to_numpy()).all(axis=1), index=frame.index)
