from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import google.generativeai as genai
import os
from dotenv import load_dotenv
import pandas as pd

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


class ChatMessage(BaseModel):
    message: str


class ChatResponse(BaseModel):
    reply: str


@app.get("/")
def root():
    return {"status": "TindaBot is running!"}


@app.post("/chat", response_model=ChatResponse)
async def chat(msg: ChatMessage):
    try:
        prompt = msg.message
        if sales_context["summary"]:
            prompt = f"[Sales Data Context]\n{sales_context['summary']}\n\n[User Question]\n{msg.message}"

        response = model.generate_content(prompt)
        return ChatResponse(reply=response.text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/load-sales")
async def load_sales(csv_path: str = "data/weekly_sales.csv"):
    try:
        df = pd.read_csv(csv_path)
        sales_context["data"] = df
        sales_context["summary"] = df.to_string(index=False)
        return {"status": "Sales data loaded", "rows": len(df), "columns": list(df.columns)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/sales-summary")
async def sales_summary():
    if sales_context["data"] is None:
        raise HTTPException(status_code=404, detail="No sales data loaded. POST to /load-sales first.")
    df = sales_context["data"]
    summary = {
        "total_revenue": float(df["total_sales"].sum()) if "total_sales" in df.columns else None,
        "top_product": df.loc[df["units_sold"].idxmax(), "product"] if "units_sold" in df.columns else None,
        "rows": len(df),
    }
    return summary
