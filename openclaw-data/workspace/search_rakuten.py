"""
Tavily search timing harness for OpenClaw / Symphony Signal.

Usage:
    python3 search_rakuten.py "<query>" [--depth basic|advanced] [--topic general|news] [--max-results N]

Output: JSON with per-phase timing and result metadata, printed to stdout.
"""

import argparse
import json
import os
import sys
import time


def run_search(query: str, depth: str = "basic", topic: str = "general", max_results: int = 5) -> dict:
    t_import_start = time.perf_counter()
    try:
        from tavily import TavilyClient
    except ImportError:
        return {"error": "tavily package not installed — run: pip install tavily-python"}
    t_import_end = time.perf_counter()

    api_key = os.environ.get("TAVILY_API_KEY")
    if not api_key:
        return {"error": "TAVILY_API_KEY environment variable not set"}

    t_client_start = time.perf_counter()
    client = TavilyClient(api_key=api_key)
    t_client_end = time.perf_counter()

    t_api_start = time.perf_counter()
    try:
        response = client.search(
            query=query,
            search_depth=depth,
            topic=topic,
            max_results=max_results,
        )
    except Exception as e:
        return {
            "error": str(e),
            "timing": {
                "import_s": round(t_import_end - t_import_start, 4),
                "client_init_s": round(t_client_end - t_client_start, 4),
                "api_call_s": round(time.perf_counter() - t_api_start, 4),
            },
        }
    t_api_end = time.perf_counter()

    results = response.get("results", [])
    result_summary = [
        {
            "title": r.get("title", ""),
            "url": r.get("url", ""),
            "score": r.get("score"),
            "content_len": len(r.get("content", "")),
        }
        for r in results
    ]

    return {
        "query": query,
        "params": {"depth": depth, "topic": topic, "max_results": max_results},
        "timing": {
            "import_s": round(t_import_end - t_import_start, 4),
            "client_init_s": round(t_client_end - t_client_start, 4),
            "api_call_s": round(t_api_end - t_api_start, 4),
            "total_s": round(t_api_end - t_import_start, 4),
        },
        "results_count": len(results),
        "results": result_summary,
        "answer": response.get("answer"),
    }


def main():
    parser = argparse.ArgumentParser(description="Tavily search timing harness")
    parser.add_argument("query", help="Search query string")
    parser.add_argument("--depth", choices=["basic", "advanced"], default="basic")
    parser.add_argument("--topic", choices=["general", "news"], default="general")
    parser.add_argument("--max-results", type=int, default=5)
    args = parser.parse_args()

    result = run_search(
        query=args.query,
        depth=args.depth,
        topic=args.topic,
        max_results=args.max_results,
    )
    print(json.dumps(result, indent=2))

    if "error" in result:
        sys.exit(1)


if __name__ == "__main__":
    main()
