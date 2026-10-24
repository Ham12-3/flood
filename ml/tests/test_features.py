import numpy as np
import pandas as pd
import pytest

from floodscope_ml.features import (
    DYNAMIC_INPUTS,
    FLOW,
    FORCINGS,
    LEADS,
    TARGETS,
    add_derived,
    lead_name,
    serving_frame,
    target_name,
)


def forcings(n: int = 20) -> pd.DataFrame:
    idx = pd.date_range("2020-01-01", periods=n, freq="D")
    return pd.DataFrame(
        {f.caravan: np.arange(n, dtype=float) + i for i, f in enumerate(FORCINGS)}, index=idx
    )


def test_feature_lists_are_consistent() -> None:
    assert len(TARGETS) == LEADS
    assert len(set(DYNAMIC_INPUTS)) == len(DYNAMIC_INPUTS)
    assert not set(TARGETS) & set(DYNAMIC_INPUTS)


def test_leads_shift_forward_and_targets_are_future_flow() -> None:
    df = forcings()
    flow = pd.Series(np.arange(20, dtype=float) + 1, index=df.index)
    out = add_derived(df, flow, mean_flow=2.0)
    precip = "total_precipitation_sum"
    assert out[lead_name(precip, 3)].iloc[0] == df[precip].iloc[3]
    assert np.isnan(out[lead_name(precip, 1)].iloc[-1])
    assert out[FLOW].iloc[4] == pytest.approx(5 / 2.0)
    assert out[target_name(1)].iloc[4] == pytest.approx(6 / 2.0)
    assert out[target_name(LEADS)].iloc[4] == pytest.approx((5 + LEADS) / 2.0)


def test_short_gaps_filled_long_gaps_left_missing() -> None:
    df = forcings()
    flow = pd.Series(1.0, index=df.index)
    flow.iloc[3:5] = np.nan  # 2-day gap: filled
    flow.iloc[10:14] = np.nan  # 4-day gap: last 2 days stay missing
    out = add_derived(df, flow, mean_flow=1.0)
    assert out[FLOW].iloc[3:5].tolist() == [1.0, 1.0]
    assert out[FLOW].iloc[10:12].tolist() == [1.0, 1.0]
    assert np.isnan(out[FLOW].iloc[12]) and np.isnan(out[FLOW].iloc[13])
    # Targets are never filled.
    assert np.isnan(out[target_name(1)].iloc[2])


def test_missing_forcing_and_bad_mean() -> None:
    df = forcings().drop(columns=[FORCINGS[0].caravan])
    with pytest.raises(KeyError, match=FORCINGS[0].caravan):
        add_derived(df, pd.Series(1.0, index=df.index), 1.0)
    with pytest.raises(ValueError):
        add_derived(forcings(), pd.Series(1.0, index=forcings().index), 0.0)


def test_serving_frame_maps_open_meteo_names_and_stops_at_issue_date() -> None:
    idx = pd.date_range("2026-01-01", periods=30, freq="D")
    weather = pd.DataFrame({f.open_meteo: np.linspace(0, 1, 30) for f in FORCINGS}, index=idx)
    flow = pd.Series(50.0, index=idx[:23])
    issue = idx[22]
    frame = serving_frame(weather, flow, glofas_mean=100.0, issue_date=issue)
    assert list(frame.columns) == list(DYNAMIC_INPUTS)
    assert frame.index[-1] == issue
    assert frame[FLOW].iloc[-1] == pytest.approx(0.5)
    # The last row's precipitation leads come from the 7 forecast days after issue.
    assert frame[lead_name("total_precipitation_sum", 7)].iloc[-1] == pytest.approx(
        weather["precipitation_sum"].iloc[29]
    )
