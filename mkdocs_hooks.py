"""MkDocs build hooks for the published documentation site.

The docs link into the repository with relative paths (``../packages/...``,
``../examples/...``) so the snippets resolve on GitHub. Those targets are not part
of the rendered site, so rewrite them to absolute GitHub ``blob`` URLs at build
time. The source Markdown keeps its GitHub-friendly relative links untouched.
"""

import re

_GH_BLOB = "https://github.com/haddowg/json-api-ts/blob/main/"

# A Markdown link ``](../.../<target>)`` into a repository path that lives outside
# docs/ (so it cannot be served): rewrite to a GitHub blob URL. <target> is a known
# top-level directory or file (a trailing path is optional).
_REPO_LINK = re.compile(
    r"\]\((?:\.\./)+((?:packages|examples|scripts|CONTEXT\.md|README\.md|LICENSE)[^)]*)\)"
)


def on_page_markdown(markdown, **kwargs):
    return _REPO_LINK.sub(rf"]({_GH_BLOB}\1)", markdown)
