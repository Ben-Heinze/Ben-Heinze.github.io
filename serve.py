"""Local dev server for the wiki, plus the new-page/delete-page/move-page CLI
(see the `just` recipes). Creating a page scaffolds a generic index.org,
appends the entry to nav.json, and rebuilds the site so the new page appears
everywhere.
"""

import datetime
import http.server
import json
import os
import re
import shutil
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, 'public')
NAV = os.path.join(ROOT, 'nav.json')

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


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

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

    os.chdir(ROOT)
    print('Serving http://localhost:8080  (Ctrl-C to stop)')
    http.server.HTTPServer(('localhost', 8080), Handler).serve_forever()


if __name__ == '__main__':
    main()
