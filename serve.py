"""Local dev server for the wiki, plus the new-page/delete-page/move-page CLI
(see the `just` recipes). Creating a page scaffolds a generic index.org,
appends the entry to nav.json, and rebuilds the site so the new page appears
everywhere.
"""

import datetime
import http.server
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, 'public')
NAV = os.path.join(ROOT, 'nav.json')

# serve.py is local-only tooling: every rebuild it runs (the dev server and the
# page-management commands) must include pages marked "private" in nav.json, so
# they stay visible while working locally. publish.el gates on this env var and
# excludes private pages by default; only the live GitHub Pages build (which
# does not set it) drops them. See page_visibility_tab / the justfile.
os.environ.setdefault('WIKI_INCLUDE_LOCAL', '1')

# ── Live reload ─────────────────────────────────────────────────────────
# The dev server watches content/ + static/ + nav.json and rebuilds on save,
# then pushes a reload event over SSE to every open page. The client script is
# injected into HTML at serve time (not baked into public/) so the built output
# stays clean and deployable elsewhere without a dev-only <script> leaking in.
RELOAD_SCRIPT = b"""<script>
(function () {
  var es = new EventSource('/__reload');
  es.onmessage = function () { location.reload(); };
})();
</script>
"""

# One Queue per connected SSE client; notify_reload() pushes to all of them.
_reload_clients = set()
_reload_lock = threading.Lock()

# content/*.org and assets rebuild incrementally (org-publish's own timestamp
# cache skips unchanged files); a nav.json change forces a full rebuild because
# the sidebar + homepage TOC are baked into every page.
WATCH_DIRS = [os.path.join(ROOT, 'content'), os.path.join(ROOT, 'static')]
WATCH_FILES = [NAV]


def build(force=False):
    """Publish the site. force=True rebuilds every page (needed when nav.json
    changed); otherwise org-publish only re-exports files whose content changed.
    """
    subprocess.run(
        ['emacs', '--batch', '-l', 'publish.el', '--eval',
         '(org-publish-all %s)' % ('t' if force else 'nil')],
        cwd=ROOT, check=True,
    )
    # Mirror the `just run` recipe: keep the served stylesheet in lockstep.
    style_src = os.path.join(ROOT, 'static', 'style.css')
    if os.path.isfile(style_src):
        shutil.copy(style_src, os.path.join(PUBLIC, 'style.css'))


def notify_reload():
    """Wake every connected SSE client so its page reloads."""
    with _reload_lock:
        clients = list(_reload_clients)
    for q in clients:
        q.put('reload')


def _snapshot():
    """Map every watched path to its mtime, for change detection."""
    state = {}
    for d in WATCH_DIRS:
        for root, _dirs, files in os.walk(d):
            for fn in files:
                p = os.path.join(root, fn)
                try:
                    state[p] = os.stat(p).st_mtime_ns
                except OSError:
                    pass
    for p in WATCH_FILES:
        try:
            state[p] = os.stat(p).st_mtime_ns
        except OSError:
            pass
    return state


def watch_loop():
    """Poll the watched trees; on change, settle briefly (so half-written saves
    don't trigger a build mid-write), rebuild, and signal a reload."""
    prev = _snapshot()
    while True:
        time.sleep(0.3)
        cur = _snapshot()
        if cur == prev:
            continue
        # Let a burst of writes settle before building.
        while True:
            time.sleep(0.3)
            newer = _snapshot()
            if newer == cur:
                break
            cur = newer
        changed = {p for p in set(cur) | set(prev)
                   if cur.get(p) != prev.get(p)}
        prev = cur
        force = NAV in changed
        try:
            build(force=force)
        except subprocess.CalledProcessError as e:
            print('build failed: ' + str(e))
            continue
        notify_reload()

# Scaffold text for a brand-new page. {{TITLE}} and {{DATE}} are substituted via
# str.replace (not .format) so the literal LaTeX braces below pass through
# untouched.
GENERIC_ORG = r"""#+TITLE: {{TITLE}}
#+AUTHOR: Ben Heinze
#+DATE: {{DATE}}
#+STARTUP: noindent

#+MACRO: hl @@html:<span class="hl-$1">$2</span>@@@@latex:\hl{$1}{$2}@@

# This is used to shrink the pdf page margins
#+LATEX_HEADER: \usepackage[left=0.75in,right=0.75in,top=1in,bottom=1in]{geometry}

# This is used to shrink the spacing between bullet points
#+LATEX_HEADER: \usepackage{enumitem}
#+LATEX_HEADER: \setlist[itemize]{itemsep=2pt, topsep=4pt}
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


def remove_entry(nav, href):
    """Remove the entry with this href from nav (searching nested children).

    Returns the removed entry (with its own children subtree intact), or None
    if no entry matched.
    """
    for i, entry in enumerate(nav):
        if entry.get('href') == href:
            return nav.pop(i)
        children = entry.get('children', [])
        removed = remove_entry(children, href)
        if removed is not None:
            if not children:  # don't leave an empty "children": [] behind
                entry.pop('children', None)
            return removed
    return None


def page_visibility_tab(href, visibility):
    """Set whether the page at HREF is published to the live website.

    visibility is 'private' (kept out of the deployed site, still shown under
    `just run`) or 'public' (published). Flips the "private" flag on the nav
    entry and rebuilds, since the nav is baked into every page.
    """
    if visibility not in ('public', 'private'):
        raise ValueError("visibility must be 'public' or 'private'")

    with open(NAV) as f:
        nav = json.load(f)

    entry = find_entry(nav, href)
    if entry is None:
        raise ValueError('page not found: ' + href)

    if visibility == 'private':
        entry['private'] = True
    else:
        entry.pop('private', None)

    with open(NAV, 'w') as f:
        json.dump(nav, f, indent=2)
        f.write('\n')

    # Full rebuild: private-ness affects both HTML emission and the nav/TOC
    # baked into every page, so all pages must be regenerated.
    subprocess.run(
        ['emacs', '--batch', '-l', 'publish.el', '--eval', '(org-publish-all t)'],
        cwd=ROOT, check=True,
    )
    return {'ok': True, 'href': href, 'visibility': visibility}


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
        today = datetime.date.today().isoformat()
        f.write(GENERIC_ORG.replace('{{TITLE}}', label).replace('{{DATE}}', today))

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


def delete_tab(href):
    """Inverse of create_tab: drop the nav entry and remove its content.

    Removing a page also removes any pages nested under it, since their content
    lives inside its directory and their nav entries hang off its subtree.
    """
    href = (href or '').strip()
    if not href:
        raise ValueError('a page path is required')

    rel_dir = href.strip('/').rsplit('/', 1)[0]  # ".../index.html" -> dir
    if not rel_dir:
        raise ValueError('refusing to delete the site root')

    with open(NAV) as f:
        nav = json.load(f)

    removed = remove_entry(nav, href)
    if removed is None:
        raise ValueError('page not found in nav: ' + href)

    with open(NAV, 'w') as f:
        json.dump(nav, f, indent=2)
        f.write('\n')

    # Delete the source and the already-published output. org-publish-all does
    # not prune stale files, so the built copy under public/ must go explicitly
    # or the deleted page would linger on the served site.
    for base in (os.path.join(ROOT, 'content', rel_dir), os.path.join(PUBLIC, rel_dir)):
        if os.path.isdir(base):
            shutil.rmtree(base)

    # Full rebuild so the removed tab disappears from the nav baked into every
    # remaining page.
    subprocess.run(
        ['emacs', '--batch', '-l', 'publish.el', '--eval', '(org-publish-all t)'],
        cwd=ROOT, check=True,
    )
    return {'ok': True, 'href': href, 'removed': removed.get('label')}


def move_tab(from_href, to_parent_href):
    """Relocate a nav entry (and its content dir + subtree) under a new parent.

    Inverse-compatible with create_tab/delete_tab: same nav.json + content/ +
    public/ manipulation, then a full rebuild. from_href is the page being
    moved; to_parent_href is its new parent (empty string for top level).
    """
    from_href = (from_href or '').strip()
    if not from_href:
        raise ValueError('a page path is required')

    old_dir = from_href.strip('/').rsplit('/', 1)[0]  # ".../index.html" -> dir
    if not old_dir:
        raise ValueError('refusing to move the site root')

    to_parent_href = (to_parent_href or '').strip()
    if to_parent_href == from_href:
        raise ValueError('cannot move a page into itself')
    if to_parent_href:
        parent_dir_check = to_parent_href.strip('/').rsplit('/', 1)[0]
        if parent_dir_check == old_dir or parent_dir_check.startswith(old_dir + '/'):
            raise ValueError('cannot move a page into its own subtree')

    with open(NAV) as f:
        nav = json.load(f)

    # Pull the entry (with its children subtree intact) out of its old spot
    # first. If to_parent_href names a descendant of the moved entry, it will
    # no longer be findable below, which naturally rejects that cycle too.
    entry = remove_entry(nav, from_href)
    if entry is None:
        raise ValueError('page not found in nav: ' + from_href)

    if to_parent_href:
        parent = find_entry(nav, to_parent_href)
        if parent is None:
            raise ValueError('parent tab not found: ' + to_parent_href)
        new_parent_dir = to_parent_href.strip('/').rsplit('/', 1)[0]
    else:
        parent = None
        new_parent_dir = ''

    slug = old_dir.rsplit('/', 1)[-1]
    new_dir = os.path.join(new_parent_dir, slug)
    if new_dir == old_dir:
        raise ValueError('page is already there')

    abs_old = os.path.join(ROOT, 'content', old_dir)
    abs_new = os.path.join(ROOT, 'content', new_dir)
    if not os.path.isdir(abs_old):
        raise ValueError('content not found: content/' + old_dir)
    if os.path.exists(abs_new):
        raise ValueError('already exists: content/' + new_dir)

    shutil.move(abs_old, abs_new)

    # org-publish-all does not prune stale files, so the old built output must
    # go explicitly or the page would linger at its old URL too.
    stale_public = os.path.join(PUBLIC, old_dir)
    if os.path.isdir(stale_public):
        shutil.rmtree(stale_public)

    def rewrite_hrefs(node):
        old_prefix, new_prefix = '/' + old_dir + '/', '/' + new_dir + '/'
        node['href'] = new_prefix + node['href'][len(old_prefix):]
        for child in node.get('children', []):
            rewrite_hrefs(child)

    rewrite_hrefs(entry)

    if parent is not None:
        parent.setdefault('children', []).append(entry)
    else:
        nav.append(entry)
    with open(NAV, 'w') as f:
        json.dump(nav, f, indent=2)
        f.write('\n')

    # Full rebuild: descendant pages' internal nav links and the site-wide
    # preamble all need to reflect the new location.
    subprocess.run(
        ['emacs', '--batch', '-l', 'publish.el', '--eval', '(org-publish-all t)'],
        cwd=ROOT, check=True,
    )
    return {'ok': True, 'from': from_href, 'to': entry['href']}


def rename_tab(from_href, new_label):
    """Rename a page: change its title, nav label, URL slug, and content dir.

    Keeps the page under the same parent (use move_tab to change parent). The
    slug/dir is re-derived from new_label, so the page's URL changes and any
    pages nested under it move with it. Mirrors move_tab's nav.json + content/
    + public/ manipulation, plus rewriting the #+TITLE: in the index.org and a
    full rebuild.
    """
    from_href = (from_href or '').strip()
    if not from_href:
        raise ValueError('a page path is required')

    new_label = (new_label or '').strip()
    if not new_label:
        raise ValueError('a new name is required')
    new_slug = slugify(new_label)
    if not new_slug:
        raise ValueError('name has no usable characters')

    old_dir = from_href.strip('/').rsplit('/', 1)[0]  # ".../index.html" -> dir
    if not old_dir:
        raise ValueError('refusing to rename the site root')

    parent_dir = old_dir.rsplit('/', 1)[0] if '/' in old_dir else ''
    new_dir = os.path.join(parent_dir, new_slug)

    with open(NAV) as f:
        nav = json.load(f)

    entry = find_entry(nav, from_href)
    if entry is None:
        raise ValueError('page not found in nav: ' + from_href)

    abs_old = os.path.join(ROOT, 'content', old_dir)
    if not os.path.isdir(abs_old):
        raise ValueError('content not found: content/' + old_dir)

    # The slug may be unchanged (e.g. renaming "Likelihood" to "Likelihood!"),
    # in which case only the label + title change and no dir move happens.
    if new_dir != old_dir:
        abs_new = os.path.join(ROOT, 'content', new_dir)
        if os.path.exists(abs_new):
            raise ValueError('already exists: content/' + new_dir)
        shutil.move(abs_old, abs_new)

        # org-publish-all does not prune stale files, so the old built output
        # must go explicitly or the page would linger at its old URL too.
        stale_public = os.path.join(PUBLIC, old_dir)
        if os.path.isdir(stale_public):
            shutil.rmtree(stale_public)

        def rewrite_hrefs(node):
            old_prefix, new_prefix = '/' + old_dir + '/', '/' + new_dir + '/'
            node['href'] = new_prefix + node['href'][len(old_prefix):]
            for child in node.get('children', []):
                rewrite_hrefs(child)

        rewrite_hrefs(entry)

    entry['label'] = new_label

    with open(NAV, 'w') as f:
        json.dump(nav, f, indent=2)
        f.write('\n')

    # Update the page's own title so it matches the nav label. The #+TITLE:
    # keyword drives the rendered heading and the <title> element.
    index_org = os.path.join(ROOT, 'content', new_dir, 'index.org')
    if os.path.isfile(index_org):
        with open(index_org) as f:
            body = f.read()
        body, n = re.subn(
            r'(?im)^#\+TITLE:.*$', lambda m: '#+TITLE: ' + new_label,
            body, count=1,
        )
        if n:
            with open(index_org, 'w') as f:
                f.write(body)

    # Full rebuild: the changed slug/label ripples into the nav baked into
    # every page and into descendant pages' internal links.
    subprocess.run(
        ['emacs', '--batch', '-l', 'publish.el', '--eval', '(org-publish-all t)'],
        cwd=ROOT, check=True,
    )
    return {'ok': True, 'from': from_href, 'to': entry['href'], 'label': new_label}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if self.path == '/__reload':
            return self._serve_reload_stream()
        fs_path = self.translate_path(self.path)
        if os.path.isdir(fs_path):
            if not self.path.rstrip('?').endswith('/'):
                self.send_response(301)
                self.send_header('Location', self.path + '/')
                self.end_headers()
                return
            fs_path = os.path.join(fs_path, 'index.html')
        if fs_path.endswith('.html') and os.path.isfile(fs_path):
            return self._serve_html(fs_path)
        return super().do_GET()

    def _serve_html(self, fs_path):
        """Serve an HTML file with the live-reload client injected before </body>."""
        with open(fs_path, 'rb') as f:
            body = f.read()
        if b'</body>' in body:
            body = body.replace(b'</body>', RELOAD_SCRIPT + b'</body>', 1)
        else:
            body += RELOAD_SCRIPT
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_reload_stream(self):
        """Hold an SSE connection open, emitting a reload event on each build."""
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        q = queue.Queue()
        with _reload_lock:
            _reload_clients.add(q)
        try:
            self.wfile.write(b': connected\n\n')
            self.wfile.flush()
            while True:
                try:
                    q.get(timeout=15)
                    self.wfile.write(b'data: reload\n\n')
                except queue.Empty:
                    self.wfile.write(b': ping\n\n')  # keepalive + detect disconnect
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with _reload_lock:
                _reload_clients.discard(q)

    def log_message(self, *a):
        pass


def main():
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == 'new-page':
        # Scaffolds the page, updates nav.json, and rebuilds the site.
        label = sys.argv[2] if len(sys.argv) > 2 else ''
        parent = sys.argv[3] if len(sys.argv) > 3 else ''
        try:
            result = create_tab(label, path_to_href(parent))
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        print('created ' + result['href'])
        return

    if len(sys.argv) > 1 and sys.argv[1] == 'delete-page':
        # Inverse of new-page: takes the same content/ path (e.g.
        # "ai/machine-learning") and removes the tab, its content, and its
        # built output, then rebuilds.
        path = sys.argv[2] if len(sys.argv) > 2 else ''
        try:
            result = delete_tab(path_to_href(path))
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        print('deleted ' + result['href'])
        return

    if len(sys.argv) > 1 and sys.argv[1] == 'move-page':
        # Relocate a page (and any pages nested under it) to a new parent.
        # Both args are content/ paths; omit the parent to move to top level.
        path = sys.argv[2] if len(sys.argv) > 2 else ''
        parent = sys.argv[3] if len(sys.argv) > 3 else ''
        try:
            result = move_tab(path_to_href(path), path_to_href(parent))
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        print('moved ' + result['from'] + ' -> ' + result['to'])
        return

    if len(sys.argv) > 1 and sys.argv[1] == 'rename-page':
        # Rename a page: takes its content/ path (e.g. "statistics/likelihood")
        # and a new title. Re-derives the slug/dir + href from the title and
        # updates the page's own #+TITLE:, keeping it under the same parent.
        path = sys.argv[2] if len(sys.argv) > 2 else ''
        new_label = sys.argv[3] if len(sys.argv) > 3 else ''
        try:
            result = rename_tab(path_to_href(path), new_label)
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        print('renamed ' + result['from'] + ' -> ' + result['to'])
        return

    if len(sys.argv) > 1 and sys.argv[1] == 'page-visibility':
        # Set whether a page is published to the live website. Takes its
        # content/ path (e.g. "job") and either "private" (kept local-only) or
        # "public", flips the flag on the nav entry, and rebuilds.
        path = sys.argv[2] if len(sys.argv) > 2 else ''
        visibility = sys.argv[3] if len(sys.argv) > 3 else ''
        try:
            result = page_visibility_tab(path_to_href(path), visibility)
        except Exception as e:
            print('error: ' + str(e), file=sys.stderr)
            sys.exit(1)
        print(result['href'] + ' is now ' + result['visibility'])
        return

    os.chdir(ROOT)
    threading.Thread(target=watch_loop, daemon=True).start()
    print('Serving http://localhost:8080  (Ctrl-C to stop)  [watching for changes]')
    # ThreadingHTTPServer so a held-open SSE reload stream doesn't block the
    # server from handling normal page requests.
    http.server.ThreadingHTTPServer(('localhost', 8080), Handler).serve_forever()


if __name__ == '__main__':
    main()
