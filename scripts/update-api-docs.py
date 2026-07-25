#!/usr/bin/env python3
"""
Extract API documentation from server.py and update docs/README.md
Run this after adding/removing/changing API endpoints.
"""
import re
import sys
from pathlib import Path

BASE = Path(__file__).parent.parent.resolve()  # Go up from scripts/ to project root
SERVER = BASE / "server.py"
DOCS = BASE / "docs" / "README.md"

def extract_endpoints():
    """Parse server.py for FastAPI route definitions."""
    content = SERVER.read_text()

    # Match @app.get/post/put/patch/delete("path")
    pattern = r'@app\.(get|post|put|patch|delete)\("([^"]+)"'
    endpoints = []
    for match in re.finditer(pattern, content):
        method = match.group(1).upper()
        path = match.group(2)
        # Find the function name after the decorator
        rest = content[match.end():match.end()+200]
        func_match = re.search(r'def\s+(\w+)', rest)
        func_name = func_match.group(1) if func_match else "?"
        endpoints.append((method, path, func_name))

    return endpoints

def generate_api_table(endpoints):
    """Generate markdown table for API reference."""
    # Group by category (based on path prefix)
    categories = {}
    for method, path, func in endpoints:
        # Extract category from path
        parts = path.split('/')
        if len(parts) >= 3:
            cat = parts[2]  # e.g. "status", "brain", "skills"
        else:
            cat = "root"
        categories.setdefault(cat, []).append((method, path, func))

    lines = []
    for cat in sorted(categories.keys()):
        lines.append(f"\n### {cat.replace('-', ' ').title()}\n")
        lines.append("| Method | Endpoint | Handler |")
        lines.append("|--------|----------|---------|")
        for method, path, func in sorted(categories[cat], key=lambda x: x[1]):
            lines.append(f"| {method} | `{path}` | `{func}` |")

    return "\n".join(lines)

def update_docs():
    """Update the API reference section in docs/README.md."""
    endpoints = extract_endpoints()
    new_api_section = generate_api_table(endpoints)

    if not DOCS.exists():
        print(f"ERROR: {DOCS} not found")
        sys.exit(1)

    content = DOCS.read_text()

    # Find and replace the API Reference section
    # Look for "## API Reference" until next "##" section
    pattern = r'(## API Reference\n).*?(?=\n## )'
    replacement = f"## API Reference\n\n{new_api_section}\n"

    if re.search(pattern, content, re.DOTALL):
        new_content = re.sub(pattern, replacement, content, flags=re.DOTALL)
        DOCS.write_text(new_content)
        print(f"Updated {DOCS} with {len(endpoints)} API endpoints")
    else:
        print("WARNING: Could not find '## API Reference' section in docs")
        print("Adding it before the last section...")
        # Find last ## section
        last_section = content.rfind("\n## ")
        if last_section >= 0:
            new_content = content[:last_section] + f"\n{replacement}\n" + content[last_section:]
            DOCS.write_text(new_content)
            print(f"Updated {DOCS} with {len(endpoints)} API endpoints")
        else:
            print("ERROR: No sections found in docs")
            sys.exit(1)

if __name__ == "__main__":
    update_docs()
