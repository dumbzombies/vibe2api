"""End-to-end checks through the official OpenAI and Anthropic SDKs."""
import json, sys, time
import openai, anthropic

BASE = "http://127.0.0.1:8788"
KEY = "local-test"
M = "mistral-small-latest"

oai = openai.OpenAI(base_url=BASE + "/v1", api_key=KEY)
ant = anthropic.Anthropic(base_url=BASE, api_key=KEY)

ok = 0
fail = []
def check(name, fn):
    global ok
    t = time.time()
    try:
        fn()
        ok += 1
        print(f"PASS {name} ({time.time()-t:.1f}s)")
    except Exception as e:
        fail.append((name, repr(e)[:400]))
        print(f"FAIL {name}: {repr(e)[:300]}")

# ---------- OpenAI ----------
def models():
    ms = oai.models.list()
    ids = [m.id for m in ms.data]
    assert any(i.startswith("mistral-") for i in ids), ids[:5]
    assert len(ids) >= 5, ids

def chat_plain():
    r = oai.chat.completions.create(model=M, max_tokens=20,
        messages=[{"role": "user", "content": "Reply with the single word OK"}])
    assert r.choices[0].message.content.strip().startswith("OK"), r.choices[0].message.content
    assert r.usage.total_tokens > 0
    assert r.choices[0].finish_reason == "stop"

def chat_stream():
    parts, usage = [], None
    with oai.chat.completions.stream(model=M, max_tokens=20,
            messages=[{"role": "user", "content": "Count 1 to 3"}]) as s:
        for ev in s:
            if ev.type == "content.delta":
                parts.append(ev.delta)
        final = s.get_final_completion()
    text = "".join(parts)
    assert "1" in text and "3" in text, text
    assert final.choices[0].message.content

def chat_tools():
    r = oai.chat.completions.create(model=M, max_tokens=60,
        messages=[{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
        tools=[{"type": "function", "function": {"name": "get_weather",
            "description": "Get weather",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}],
        tool_choice="auto")
    msg = r.choices[0].message
    assert msg.tool_calls, f"no tool_calls, content={msg.content!r} finish={r.choices[0].finish_reason}"
    args = json.loads(msg.tool_calls[0].function.arguments)
    assert "city" in args, args

def chat_tools_stream():
    calls = []
    with oai.chat.completions.stream(model=M, max_tokens=60,
            messages=[{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
            tools=[{"type": "function", "function": {"name": "get_weather",
                "description": "Get weather",
                "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]) as s:
        for ev in s:
            if ev.type == "tool_calls.function.arguments.done":
                calls.append((ev.name, ev.arguments))
    assert calls, "no streamed tool call"
    assert "city" in json.loads(calls[0][1]), calls

def chat_stop():
    r = oai.chat.completions.create(model=M, max_tokens=50, stop=["5"],
        messages=[{"role": "user", "content": "Count 1 to 9, comma separated"}])
    assert "5" not in (r.choices[0].message.content or ""), (r.choices[0].message.content, r.choices[0].finish_reason)

def chat_reasoning_model():
    parts = []
    with oai.chat.completions.stream(model="deepseek-v4-1-flash-1017", max_tokens=128,
            messages=[{"role": "user", "content": "What is 17*23? Answer with the number."}]) as s:
        for ev in s:
            if ev.type == "content.delta":
                parts.append(ev.delta)
    text = "".join(parts)
    assert "391" in text, text[:200]

def chat_system_multi():
    r = oai.chat.completions.create(model=M, max_tokens=20, temperature=0,
        messages=[{"role": "system", "content": "You answer in French."},
                  {"role": "user", "content": "Say: good morning"},
                  {"role": "assistant", "content": "Bonjour"},
                  {"role": "user", "content": "Say: goodbye"}])
    assert r.choices[0].message.content

# ---------- Anthropic ----------
def ant_plain():
    r = ant.messages.create(model=M, max_tokens=30, system="Be terse.",
        messages=[{"role": "user", "content": "Say hi in 2 words"}])
    assert r.type == "message" and r.role == "assistant"
    assert r.content and r.content[0].type == "text" and r.content[0].text
    assert r.stop_reason in ("end_turn", "max_tokens"), r.stop_reason
    assert r.usage.input_tokens > 0 and r.usage.output_tokens > 0, r.usage

def ant_stream():
    text, events = [], []
    with ant.messages.stream(model=M, max_tokens=30,
            messages=[{"role": "user", "content": "Count 1 to 3"}]) as s:
        for ev in s:
            events.append(ev.type)
            if ev.type == "content_block_delta" and ev.delta.type == "text_delta":
                text.append(ev.delta.text)
    final = s.get_final_message()
    assert "1" in "".join(text) and "3" in "".join(text), "".join(text)
    assert final.stop_reason == "end_turn", final.stop_reason
    assert "message_start" in events and "message_stop" in events
    assert final.usage.output_tokens > 0

def ant_tools():
    r = ant.messages.create(model=M, max_tokens=80,
        messages=[{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
        tools=[{"name": "get_weather", "description": "Get weather",
                "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])
    assert r.stop_reason == "tool_use", (r.stop_reason, r.content)
    tu = [b for b in r.content if b.type == "tool_use"]
    assert tu and "city" in (tu[0].input or {}), r.content

def ant_tools_stream():
    blocks = {}
    with ant.messages.stream(model=M, max_tokens=80,
            messages=[{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
            tools=[{"name": "get_weather", "description": "Get weather",
                    "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}]) as s:
        for ev in s:
            if ev.type == "content_block_start" and ev.content_block.type == "tool_use":
                blocks[ev.index] = {"name": ev.content_block.name, "json": ""}
            if ev.type == "content_block_delta" and ev.delta.type == "input_json_delta":
                blocks[ev.index]["json"] += ev.delta.partial_json
    assert blocks, "no tool_use block streamed"
    parsed = [json.loads(b["json"]) for b in blocks.values() if b["json"]]
    assert parsed and "city" in parsed[0], (blocks, parsed)

def ant_tool_result_roundtrip():
    r1 = ant.messages.create(model=M, max_tokens=80,
        messages=[{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
        tools=[{"name": "get_weather", "description": "Get weather",
                "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])
    tu = [b for b in r1.content if b.type == "tool_use"][0]
    r2 = ant.messages.create(model=M, max_tokens=40,
        messages=[{"role": "user", "content": "What is the weather in Paris? Use the tool."},
                  {"role": "assistant", "content": r1.content},
                  {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tu.id, "content": "18C, sunny"}]}],
        tools=[{"name": "get_weather", "description": "Get weather",
                "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])
    txt = "".join(b.text for b in r2.content if b.type == "text")
    assert "18" in txt or "sunny" in txt.lower(), (txt, r2.stop_reason)

def ant_content_blocks_request():
    r = ant.messages.create(model=M, max_tokens=20,
        messages=[{"role": "user", "content": [{"type": "text", "text": "Say OK"}]}])
    assert r.content[0].text

def ant_error_shape():
    try:
        ant.messages.create(model="does-not-exist-model", max_tokens=5,
            messages=[{"role": "user", "content": "x"}])
        raise AssertionError("expected error")
    except anthropic.APIStatusError as e:
        assert e.status_code >= 400, e.status_code

check("openai models.list", models)
check("openai chat plain", chat_plain)
check("openai chat stream", chat_stream)
check("openai tools", chat_tools)
check("openai tools stream", chat_tools_stream)
check("openai stop sequences", chat_stop)
check("openai reasoning model stream", chat_reasoning_model)
check("openai system+multiturn", chat_system_multi)
check("anthropic plain", ant_plain)
check("anthropic stream", ant_stream)
check("anthropic tools", ant_tools)
check("anthropic tools stream", ant_tools_stream)
check("anthropic tool_result roundtrip", ant_tool_result_roundtrip)
check("anthropic content blocks request", ant_content_blocks_request)
check("anthropic error shape", ant_error_shape)

print(f"\n{ok} passed, {len(fail)} failed")
for n, e in fail:
    print(f"  - {n}: {e}")
sys.exit(1 if fail else 0)
