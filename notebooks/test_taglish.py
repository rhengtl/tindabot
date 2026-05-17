"""Quick test: Gemini 2.5 Flash with Taglish sari-sari store persona."""
import sys
import os
sys.stdout.reconfigure(encoding='utf-8')
from dotenv import load_dotenv
import google.generativeai as genai

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../backend/.env"))

genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

SYSTEM_PROMPT = """Ikaw ay si TindaBot, isang matalinong assistant para sa sari-sari store.
Nagsasalita ka sa Taglish — halong Tagalog at English — na palakaibigan at natural,
tulad ng isang tindero/tindera sa tabi-bahay.

Tumutulong ka sa pag-analyze ng weekly sales data at mga rekomendasyon para sa store owners.
Gumamit ng peso sign (₱) para sa presyo.
"""

model = genai.GenerativeModel(
    model_name="gemini-2.5-flash",
    system_instruction=SYSTEM_PROMPT,
    generation_config=genai.GenerationConfig(
        temperature=0.7,
        top_p=0.9,
        max_output_tokens=512,
    ),
)

test_prompts = [
    "Kamusta! Sino ka at paano mo ako matutulungan sa aking tindahan?",
    "Ang Lucky Me Pancit Canton ay nagbenta ng 80 packs kahapon. Maganda ba ito?",
    "Anong produkto ang dapat ko i-restock this week base sa mabentang items?",
]

print("=" * 60)
print("TindaBot Taglish Test — Gemini 2.5 Flash")
print("=" * 60)

for i, prompt in enumerate(test_prompts, 1):
    print(f"\n[Test {i}] User: {prompt}")
    print("-" * 40)
    response = model.generate_content(prompt)
    print(f"TindaBot: {response.text}")
    print()
