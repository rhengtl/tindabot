from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import google.generativeai as genai
import os
import io
from dotenv import load_dotenv
import pandas as pd
from forecaster import run_forecast

load_dotenv()

genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

app = FastAPI(title="TindaBot API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SYSTEM_PROMPT = """Ikaw ay si TindaBot, isang matalinong assistant para sa sari-sari store.
Nagsasalita ka sa Taglish — halong Tagalog at English — na palakaibigan at natural,
tulad ng isang tindero/tindera sa tabi-bahay.

Tumutulong ka sa:
- Pag-analyze ng weekly sales data (Lucky Me noodles, bigas, softdrinks, canned goods, atbp.)
- Mga rekomendasyon kung aling produkto ang mabenta at dapat i-restock
- Pagsagot ng tanong tungkol sa inventory at kita
- Simpleng business tips para sa sari-sari store owners

Maging maayos, mabilis, at praktikal ang sagot. Gumamit ng peso sign (₱) para sa presyo.
Kung may CSV data, i-summarize mo ito nang malinaw.
"""

model = genai.GenerativeModel(
    model_name="gemini-2.5-flash",
    system_instruction=SYSTEM_PROMPT,
    generation_config=genai.GenerationConfig(
        temperature=0.7,
        top_p=0.9,
        max_output_tokens=1024,
    ),
)

sales_context = {"data": None, "summary": None}
forecast_context: list[dict] = []


class ChatMessage(BaseModel):
    message: str


class ChatResponse(BaseModel):
    reply: str


class ForecastRequest(BaseModel):
    inventory: dict[str, int] = {}
    days_ahead: int = 7


@app.get("/")
def root():
    return {"status": "TindaBot is running!"}


def _build_forecast_summary(forecasts: list[dict]) -> str:
    lines = ["Product | Avg Daily Sales | Stock | Days Until Stockout"]
    for f in forecasts:
        stock = f.get("current_stock", "N/A")
        days = f.get("days_until_stockout")
        days_str = f"~{days} days" if days is not None else "unknown (no stock count)"
        lines.append(f"{f['product']} | {f['avg_daily_sales']}/day | {stock} units | {days_str}")
    return "\n".join(lines)


@app.post("/chat", response_model=ChatResponse)
async def chat(msg: ChatMessage):
    try:
        sections = []
        if sales_context["summary"]:
            sections.append(f"[Weekly Sales Data]\n{sales_context['summary']}")
        if forecast_context:
            sections.append(f"[Prophet Inventory Forecast]\n{_build_forecast_summary(forecast_context)}")
        sections.append(f"[User Question]\n{msg.message}")

        response = model.generate_content("\n\n".join(sections))
        return ChatResponse(reply=response.text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


REQUIRED_COLUMNS = {"date", "product", "units_sold"}


@app.post("/load-sales")
async def load_sales(file: UploadFile = File(...)):
    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only .csv files are supported.")
    try:
        content = await file.read()
        df = pd.read_csv(io.BytesIO(content))
    except Exception:
        raise HTTPException(status_code=400, detail="Could not parse the file. Make sure it's a valid CSV.")

    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing required columns: {', '.join(sorted(missing))}")

    sales_context["data"] = df
    sales_context["summary"] = df.to_string(index=False)
    forecast_context.clear()

    products = sorted(df["product"].unique().tolist())
    return {"status": "Sales data loaded", "rows": len(df), "products": products}


@app.post("/forecast")
async def forecast(req: ForecastRequest):
    if sales_context["data"] is None:
        raise HTTPException(status_code=400, detail="Load sales data first via POST /load-sales")
    try:
        results = run_forecast(sales_context["data"], req.inventory, req.days_ahead)
        forecast_context.clear()
        forecast_context.extend(results)
        return {"days_ahead": req.days_ahead, "forecasts": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/sales-summary")
async def sales_summary():
    if sales_context["data"] is None:
        raise HTTPException(status_code=404, detail="No sales data loaded. POST to /load-sales first.")
    df = sales_context["data"]

    has_units    = "units_sold"  in df.columns
    has_revenue  = "total_sales" in df.columns
    has_category = "category"    in df.columns
    has_date     = "date"        in df.columns

    total_revenue    = float(df["total_sales"].sum())  if has_revenue else None
    total_units_sold = int(df["units_sold"].sum())     if has_units   else None

    if has_units:
        by_product       = df.groupby("product")["units_sold"].sum()
        top_product      = by_product.idxmax()
        top_product_units = int(by_product.max())
    else:
        top_product = top_product_units = None

    if has_category and has_units:
        by_category        = df.groupby("category")["units_sold"].sum()
        top_category       = by_category.idxmax()
        top_category_units = int(by_category.max())
    else:
        top_category = top_category_units = None

    if has_date and has_revenue:
        by_day           = df.groupby("date")["total_sales"].sum()
        best_day         = by_day.idxmax()
        best_day_revenue = float(by_day.max())
    elif has_date and has_units:
        by_day           = df.groupby("date")["units_sold"].sum()
        best_day         = by_day.idxmax()
        best_day_revenue = None
    else:
        best_day = best_day_revenue = None

    date_range = {"from": str(df["date"].min()), "to": str(df["date"].max())} if has_date else None

    return {
        "total_revenue":     total_revenue,
        "total_units_sold":  total_units_sold,
        "top_product":       top_product,
        "top_product_units": top_product_units,
        "top_category":      top_category,
        "top_category_units": top_category_units,
        "best_day":          best_day,
        "best_day_revenue":  best_day_revenue,
        "date_range":        date_range,
    }
