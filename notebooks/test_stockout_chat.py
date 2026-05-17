"""
End-to-end test: verify the chatbot answers stockout questions
using Prophet forecast results injected into the prompt.

Flow: load CSV → run forecast → ask chat about Coca-Cola stockout
"""
import sys, os
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../backend"))

import pandas as pd
from dotenv import load_dotenv
import google.generativeai as genai
from forecaster import run_forecast

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

SYSTEM_PROMPT = """Ikaw ay si TindaBot, isang matalinong assistant para sa sari-sari store.
Nagsasalita ka sa Taglish — halong Tagalog at English — na palakaibigan at natural.
Maging maayos, mabilis, at praktikal ang sagot. Gumamit ng peso sign (₱) para sa presyo.
"""

gemini = genai.GenerativeModel(
    model_name="gemini-2.5-flash",
    system_instruction=SYSTEM_PROMPT,
    generation_config=genai.GenerationConfig(temperature=0.7, max_output_tokens=512),
)

# --- Step 1: Load sales data ---
df = pd.read_csv(os.path.join(os.path.dirname(__file__), "../data/weekly_sales.csv"))
print(f"[1] Sales data loaded — {len(df)} rows, {df['product'].nunique()} products\n")

# --- Step 2: Run Prophet forecast with sample inventory ---
inventory = {
    "Coca-Cola 1.5L": 15,
    "Lucky Me Pancit Canton Original": 40,
    "Sinandomeng Rice (1kg)": 80,
    "Ligo Sardines in Tomato Sauce": 10,
    "Century Tuna Hot & Spicy": 50,
}
forecasts = run_forecast(df, inventory, days_ahead=7)
print("[2] Prophet forecast complete:")
for f in forecasts:
    if "message" in f:
        print(f"    {f['message']}")
print()

# --- Step 3: Build context (same logic as main.py) ---
def build_forecast_summary(results):
    lines = ["Product | Avg Daily Sales | Stock | Days Until Stockout"]
    for f in results:
        stock = f.get("current_stock", "N/A")
        days = f.get("days_until_stockout")
        days_str = f"~{days} days" if days is not None else "unknown (no stock count)"
        lines.append(f"{f['product']} | {f['avg_daily_sales']}/day | {stock} units | {days_str}")
    return "\n".join(lines)

# --- Step 4: Ask the chatbot about a specific product ---
questions = [
    "Kailan mauubos ang Coca-Cola 1.5L? Ilang araw pa ang stock namin?",
    "Which products need to be restocked the most urgently this week?",
]

print("[3] Chatbot verification:\n" + "=" * 55)
for q in questions:
    prompt = "\n\n".join([
        f"[Prophet Inventory Forecast]\n{build_forecast_summary(forecasts)}",
        f"[User Question]\n{q}",
    ])
    response = gemini.generate_content(prompt)
    print(f"\nQ: {q}")
    print(f"TindaBot: {response.text}")
    print("-" * 55)
