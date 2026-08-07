"""Local dev server for the wiki.

Serves the built site from public/ (with no-cache headers) and exposes a small
authoring endpoint, POST /api/new-tab, used by the "+ New page" dialog in the
nav. Creating a page scaffolds a generic index.org, appends the entry to
nav.json, and rebuilds the site so the new page appears everywhere.

This is a local authoring convenience only; a deployed static host has no
backend, so the dialog simply won't work there (the fetch fails harmlessly).
"""

import http.server
import json
import os
import re
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, 'public')
NAV = os.path.join(ROOT, 'nav.json')

# The table of contents is generated automatically from the headings in the
# file (toc:2 = down to two levels), so each "* Heading" the author adds shows
# up in the contents box. The scaffold ships with two headings and one runnable
# Babel block as a starting point.
GENERIC_ORG = """#+TITLE: {title}
#+OPTIONS: toc:2 num:nil

* Writing this page

Each =* Heading= you add below becomes an entry in the table of contents at the
top of the page — no need to maintain it by hand.

Split long notes into their own files in ={content_dir}/= and pull them in with:

#+begin_example
,#+INCLUDE: "some-topic.org" :minlevel 2
#+end_example

* Running code

Put runnable code in a source block. In Emacs, press =C-c C-c= inside the block
to execute it and store its output, then rebuild to publish the result.

#+begin_src python :results output :exports both
for n in range(1, 6):
    print(f"{{n}} squared is {{n * n}}")
#+end_src
"""


def slugify(label):
    slug = re.sub(r'[^a-z0-9]+', '-', label.strip().lower()).strip('-')
    return slug


def path_to_href(path):
    """Turn a content/ path like 'ai/machine-learning' into a nav href.

    Empty means top level. Mirrors how nav hrefs are stored (see nav.json).
    """
    path = (path or '').strip('/')
    return '/' + path + '/index.html' if path else ''


def find_entry(nav, href):
    for entry in nav:
        if entry.get('href') == href:
            return entry
        found = find_entry(entry.get('children', []), href)
        if found:
            return found
    return None


def create_tab(label, parent_href):
    label = (label or '').strip()
    if not label:
        raise ValueError('a name is required')
    slug = slugify(label)
    if not slug:
        raise ValueError('name has no usable characters')

    with open(NAV) as f:
        nav = json.load(f)

    if parent_href:
        parent = find_entry(nav, parent_href)
        if parent is None:
            raise ValueError('parent tab not found: ' + parent_href)
        parent_dir = parent_href.strip('/').rsplit('/', 1)[0]  # ".../index.html" -> dir
        rel_dir = os.path.join(parent_dir, slug)
    else:
        parent = None
        rel_dir = slug

    href = '/' + rel_dir + '/index.html'
    abs_dir = os.path.join(ROOT, 'content', rel_dir)
    if os.path.exists(abs_dir):
        raise ValueError('already exists: content/' + rel_dir)

    os.makedirs(abs_dir)
    with open(os.path.join(abs_dir, 'index.org'), 'w') as f:
        f.write(GENERIC_ORG.format(title=label, content_dir='content/' + rel_dir))

    entry = {'label': label, 'href': href}
    if parent is not None:
        parent.setdefault('children', []).append(entry)
    else:
        nav.append(entry)
    with open(NAV, 'w') as f:
        json.dump(nav, f, indent=2)
        f.write('\n')

    # Full rebuild: the nav is baked into every page, so all pages must be
    # regenerated for the new tab to show up site-wide.
    subprocess.run(
        ['emacs', '--batch', '-l', 'publish.el', '--eval', '(org-publish-all t)'],
        cwd=ROOT, check=True,
    )
    return {'ok': True, 'href': href}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/api/new-tab':
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            data = json.loads(self.rfile.read(length) or b'{}')
            self._send_json(200, create_tab(data.get('label'), data.get('parentHref')))
        except Exception as e:  # surface the message back to the browser
            self._send_json(400, {'ok': False, 'error': str(e)})


def main():
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == 'new-page':
        # Terminal equivalent of the "+ New page" dialog: same create_tab code
        # path, so it scaffolds, updates nav.json, and rebuilds identically.
        label = sys.argv[2] if len(sys.argv) > 2 else ''
        parent = sys.argv[3] if len(sys.argv) > 3 else ''
        try:
            result = create_tab(label, path_to_href(parent))
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        print('created ' + result['href'])
        return

    os.chdir(ROOT)
    print('Serving http://localhost:8080  (Ctrl-C to stop)')
    http.server.HTTPServer(('localhost', 8080), Handler).serve_forever()


if __name__ == '__main__':
    main()
