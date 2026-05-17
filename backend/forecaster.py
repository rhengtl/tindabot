import logging
logging.getLogger("cmdstanpy").setLevel(logging.WARNING)
logging.getLogger("prophet").setLevel(logging.WARNING)

import pandas as pd
from prophet import Prophet


def _fit_product(ds_y: pd.DataFrame) -> Prophet:
    """Fit a minimal Prophet model on a (ds, y) dataframe."""
    m = Prophet(
        weekly_seasonality=False,
        yearly_seasonality=False,
        daily_seasonality=False,
        changepoint_prior_scale=0.3,
        uncertainty_samples=0,  # skip uncertainty intervals — faster, not needed here
    )
    m.fit(ds_y, iter=300)
    return m


def run_forecast(df: pd.DataFrame, inventory: dict[str, int], days_ahead: int = 7) -> list[dict]:
    """
    df: the raw sales DataFrame with columns [date, product, units_sold, ...]
    inventory: {product_name: current_stock_units}
    days_ahead: how many days to forecast forward

    Returns a list of per-product forecast dicts.
    """
    results = []

    for product, group in df.groupby("product"):
        prophet_df = (
            group[["date", "units_sold"]]
            .rename(columns={"date": "ds", "units_sold": "y"})
            .copy()
        )
        prophet_df["ds"] = pd.to_datetime(prophet_df["ds"])
        prophet_df = prophet_df.sort_values("ds")

        try:
            model = _fit_product(prophet_df)
            future = model.make_future_dataframe(periods=days_ahead, freq="D")
            forecast = model.predict(future)
            future_preds = forecast.tail(days_ahead)["yhat"]
            avg_daily = max(round(float(future_preds.mean()), 1), 0.1)
        except Exception:
            # Fallback: simple 7-day rolling average
            avg_daily = max(round(float(prophet_df["y"].mean()), 1), 0.1)

        item: dict = {
            "product": product,
            "avg_daily_sales": avg_daily,
        }

        stock = inventory.get(product)
        if stock is not None:
            days_left = stock / avg_daily
            short_name = _short_name(product)
            item["current_stock"] = stock
            item["days_until_stockout"] = round(days_left, 1)
            item["message"] = _stockout_message(short_name, days_left, stock)

        results.append(item)

    results.sort(key=lambda x: x.get("days_until_stockout", float("inf")))
    return results


def _short_name(product: str) -> str:
    """Trim long product names to the first two words for readable messages."""
    words = product.split()
    return " ".join(words[:3]) if len(words) > 3 else product


def _stockout_message(name: str, days: float, stock: int) -> str:
    if days <= 1:
        return f"Pabilis! Mauubos na ang {name} ngayon or bukas — mag-restock ka na agad! (stock: {stock} units)"
    if days <= 3:
        return f"Babala: mauubos ang {name} in ~{int(days)} days. I-restock mo na soon! (stock: {stock} units)"
    if days <= 7:
        return f"Based on your sales, you'll run out of {name} in ~{int(days)} days. Order na this week."
    return f"{name} ay okay pa — estimated {int(days)} days of stock remaining."
