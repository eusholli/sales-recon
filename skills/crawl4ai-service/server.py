import logging
import time

from mcp.server.fastmcp import FastMCP
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode
import asyncio

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [crawl4ai] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("crawl4ai-service")

# Initialize FastMCP server
mcp = FastMCP("crawl4ai-service")


@mcp.tool()
async def crawl_url(url: str, extraction_strategy: str = "markdown") -> str:
    """
    Crawls a URL and returns the content in the specified format (default: markdown).
    Perfect for reading documentation, articles, or any web content to get a clean LLM-friendly representation.

    Args:
        url: The URL to crawl.
        extraction_strategy: "markdown" (default) or "html".
    """
    t_total_start = time.perf_counter()
    log.info("crawl_url START url=%s strategy=%s", url, extraction_strategy)

    t_browser_start = time.perf_counter()
    browser_config = BrowserConfig(
        headless=True,
        verbose=False,
    )
    run_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
    )
    t_browser_end = time.perf_counter()
    log.info("browser_config_init Δt=%.3fs", t_browser_end - t_browser_start)

    t_fetch_start = time.perf_counter()
    async with AsyncWebCrawler(config=browser_config) as crawler:
        t_crawler_ready = time.perf_counter()
        log.info("crawler_ready (pool_acquire) Δt=%.3fs", t_crawler_ready - t_fetch_start)

        result = await crawler.arun(url=url, config=run_config)
        t_fetch_end = time.perf_counter()
        log.info("http_fetch+dom_load Δt=%.3fs success=%s", t_fetch_end - t_crawler_ready, result.success)

    t_extract_start = time.perf_counter()
    if result.success:
        content = result.html if extraction_strategy == "html" else result.markdown
        content_len = len(content) if content else 0
    else:
        content = f"Error crawling {url}: {result.error_message}"
        content_len = 0
    t_extract_end = time.perf_counter()
    log.info("content_extraction Δt=%.3fs len=%d", t_extract_end - t_extract_start, content_len)

    t_total_end = time.perf_counter()
    log.info(
        "crawl_url END url=%s total=%.3fs fetch=%.3fs extract=%.3fs",
        url,
        t_total_end - t_total_start,
        t_fetch_end - t_fetch_start,
        t_extract_end - t_extract_start,
    )

    return content


if __name__ == "__main__":
    mcp.run()
