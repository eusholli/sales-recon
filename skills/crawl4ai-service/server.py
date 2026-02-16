from mcp.server.fastmcp import FastMCP
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode
import asyncio

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
    browser_config = BrowserConfig(
        headless=True,
        verbose=True,
    )
    
    # Configure run with cache disabled to ensure fresh content
    run_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        # word_count_threshold=10, # default is appropriate
    )

    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(
            url=url,
            config=run_config
        )

        if result.success:
            if extraction_strategy == "html":
                return result.html
            else:
                return result.markdown
        else:
            return f"Error crawling {url}: {result.error_message}"

if __name__ == "__main__":
    mcp.run()
