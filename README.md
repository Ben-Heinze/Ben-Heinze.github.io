# yappopotamus

Personal wiki built with [Org mode](https://orgmode.org/), published to a static HTML website via Emacs `org-publish`. Content lives as plain-text `.org` files organized by subject. A single build command turns them into a browsable site with syntax-highlighted, executable code blocks.

---

## Table of Contents

1. [How It Works](#how-it-works)
2. [Prerequisites](#prerequisites)
3. [Getting Started](#getting-started)
4. [Directory Structure](#directory-structure)
5. [Why Emacs?](#why-emacs)
6. [Org Mode Basics](#org-mode-basics)
7. [Org Babel: Runnable Code Blocks](#org-babel-runnable-code-blocks)
8. [#+INCLUDE: Single Source of Truth](#include-single-source-of-truth)
9. [Emacs Interactive Commands](#emacs-interactive-commands)
10. [How to Add a New Snippet](#how-to-add-a-new-snippet)
11. [How to Add a New Tab / Section](#how-to-add-a-new-tab--section)
12. [Citations & Bibliography](#citations--bibliography)
13. [Building the Site](#building-the-site)
14. [Initial Project Setup Notes](#initial-project-setup-notes)

---

## How It Works

The pipeline has three layers:

```
content/**/*.org  →  Emacs (org-publish)  →  public/ (HTML + CSS)
```

**Layer 1 — Content (`.org` files)**
You write plain-text Org mode files in `content/`. Each subject has its own folder. Small, self-contained snippet files (one concept each) live inside each folder and get stitched into that folder's `index.org` via `#+INCLUDE`.

**Layer 2 — Build (`publish.el` + `org-publish`)**
Running `emacs --batch -l publish.el -f org-publish-all` does the following for every `.org` file:
1. Resolves all `#+INCLUDE` directives, assembling the full document.
2. Executes every Org Babel code block (Python, R, shell, etc.), captures the output, and inserts it into the document as a `#+RESULTS:` block.
3. Converts the assembled document to HTML, injecting the nav bar and stylesheet.
4. Writes the result to `public/` mirroring the `content/` directory structure.

Static files (images, PDFs, the stylesheet) are copied to `public/` as-is.

**Layer 3 — Output (`public/`)**
A self-contained static website. No server, no database. Serve it locally with Python's built-in HTTP server, or deploy the folder to any web host.

**What Nix does**
Nix pins exact versions of Emacs, Python, and R into your shell via `flake.nix`. When Babel executes a code block, it calls the binaries Nix provides. Anyone who clones this repo and enters the Nix shell gets an identical environment.

---

## Prerequisites

- **Nix** with flakes enabled (`experimental-features = nix-command flakes` in `~/.config/nix/nix.conf`)
- **direnv** installed and hooked into your shell

No manual Emacs installation, no pip, no R setup — Nix handles all of it.

---

## Getting Started

**1. Allow direnv (first time only)**

```bash
direnv allow
```

This triggers Nix to build the dev shell defined in `flake.nix`, which provides `emacs`, `python3`, and `R`. Subsequent `cd`s into the project load the shell instantly from cache.

**2. Build the site**

```bash
emacs --batch -l publish.el -f org-publish-all
```

Output lands in `public/`.

**3. View the site**

```bash
python3 -m http.server 8080 --directory public/
```

Open `http://localhost:8080` in a browser.

> **Why not just open `public/index.html` directly?**
> The stylesheet is referenced as `/style.css` (a root-relative path). Browsers resolve root-relative paths against a server root, not the filesystem. The Python HTTP server provides that root. Opening the file directly will load the page without any styling.

---

## Directory Structure

```
yappopotamus/
│
├── flake.nix                  Nix dev shell — pins Emacs, Python, R
├── .envrc                     Tells direnv to use the Nix flake
├── publish.el                 Emacs Lisp config that drives org-publish
│
├── content/                   All .org source files
│   ├── index.org              Home page
│   ├── algorithms/
│   │   ├── index.org          Algorithms tab — includes snippets below
│   │   └── fibonacci.org      Snippet: recursive Fibonacci in Python
│   ├── ai/
│   │   └── index.org          AI tab
│   ├── linear-algebra/
│   │   └── index.org          Linear Algebra tab
│   ├── statistics/
│   │   ├── index.org          Statistics tab — includes snippets below
│   │   └── linear-regression.org  Snippet: linear regression in R
│   └── examples/
│       ├── index.org          Examples tab — includes all snippets below
│       ├── python-block.org   Python code block reference
│       ├── r-block.org        R code block reference
│       ├── tables.org         Manual and generated tables
│       ├── links-and-files.org  PDF, image, and page links
│       ├── text-formatting.org  Inline markup, lists, block quotes
│       └── named-blocks.org   #+NAME and #+CALL reuse patterns
│
├── static/
│   └── style.css              Global stylesheet (copied to public/)
│
└── public/                    Generated output — do not edit by hand
    ├── index.html
    ├── style.css
    ├── algorithms/
    │   ├── index.html
    │   └── fibonacci.html
    └── ...
```

`public/` is gitignored. It is always regenerable from the source files.

---

## Why Emacs?

Org mode is not ust a file format — it is an Emacs subsystem. The `org-publish` function that converts `.org` files to HTML lives inside Emacs and can only be called from within an Emacs process. The `--batch` flag runs Emacs headlessly (no window, no UI), so the build command works in any terminal without opening an editor.

You do not need to use Emacs as your day-to-day editor. You can write `.org` files in any text editor. However, Emacs gives you significant advantages when working with Org files interactively:

- Execute code blocks and see results inline without rebuilding the whole site.
- Toggle image display inside the editor.
- Fold and unfold sections to navigate large documents.
- Edit source blocks in a dedicated buffer with full language support.

These are conveniences, not requirements. The build pipeline works regardless of which editor you write the files in.

---

## Org Mode Basics

An `.org` file is plain text with a small set of markup conventions.

**Headings** — defined by leading `*` characters. Depth is determined by the number of `*`s.

```org
* Top-level heading
** Second-level heading
*** Third-level heading
```

**Document metadata** — keyword lines at the top of the file.

```org
#+TITLE: My Page Title
#+AUTHOR: Ben Heinze
#+OPTIONS: toc:2 num:nil
```

`toc:2` generates a table of contents down to 2 heading levels deep. `num:nil` disables section numbering.

**Formatting**

```org
*bold*   /italic/   =code=   ~verbatim~   +strikethrough+
```

**Links**

```org
[[https://example.com][Link text]]        External URL
[[file:other-page.org][Other page]]       Link to another .org file
[[file:images/photo.png]]                 Inline image (no link text = renders as image)
[[file:pdfs/paper.pdf][Read the paper]]   Link to a PDF
```

**Block quotes**

```org
#+begin_quote
This text will appear as a block quote.
#+end_quote
```

**Example blocks** (displayed verbatim, not executed)

```org
#+begin_example
this is shown as-is, no syntax highlighting
#+end_example
```

> **Gotcha — `#+` keywords inside example blocks:** Org's preprocessor runs before it fully parses block boundaries, so a line like `#+INCLUDE:` inside a `#+begin_example` will still be executed rather than shown literally. To display a `#+` keyword as plain text inside an example block, prefix it with a comma:
> ```org
> #+begin_example
> ,#+INCLUDE: "fibonacci.org" :minlevel 2
> #+end_example
> ```
> The comma is stripped from the output — readers see `#+INCLUDE:` — but the preprocessor skips it. The same rule applies to `#+begin_src`, `#+RESULTS:`, and any other `#+` keyword you want to show as an example rather than execute.

**Tables** — Org auto-aligns them when you press `TAB` inside the table in Emacs.

```org
| Name     | Value |
|----------+-------|
| Alpha    |    42 |
| Beta     |    99 |
```

**Including another file**

```org
#+INCLUDE: "snippet.org" :minlevel 2
```

See the [#+INCLUDE section](#include-single-source-of-truth) below for full details.

---

## Org Babel: Runnable Code Blocks

Org Babel is the subsystem that handles executable code inside Org files.

**Basic syntax**

```org
#+begin_src python :results output
print("hello from Python")
#+end_src
```

The `:results output` header argument tells Babel to capture what the block prints to stdout. Other common header arguments:

| Argument | Effect |
|---|---|
| `:results output` | Capture printed output (stdout) |
| `:results value` | Capture the return value of the last expression |
| `:results silent` | Run the block but don't insert results |
| `:eval never` | Show the block in the export but never execute it |
| `:exports both` | Show both the code and its results in the HTML |
| `:exports code` | Show only the code (default) |
| `:exports results` | Show only the results |
| `:exports none` | Show neither (useful for setup blocks) |

**Supported languages**

This repo has Python, R, shell, and Emacs Lisp enabled in `publish.el`. To add another language, add it to `org-babel-do-load-languages` in `publish.el`:

```elisp
(org-babel-do-load-languages
 'org-babel-load-languages
 '((python      . t)
   (R           . t)
   (shell       . t)
   (emacs-lisp  . t)
   (ulia       . t)   ; add new languages here
   (sql         . t)))
```

Then add the runtime to `flake.nix` if it isn't already there.

**Named blocks**

You can give a block a name and call it from elsewhere in the same document:

```org
#+NAME: compute-mean
#+begin_src python :var data='[1,2,3,4,5]' :results value
return sum(data) / len(data)
#+end_src

#+CALL: compute-mean(data='[10,20,30]')
```

`#+CALL:` re-runs the named block with different arguments and inserts the result inline. This is useful when the same computation needs to appear with multiple inputs across one page.

**What happens during export**

When `org-publish` runs, every code block (that isn't marked `:eval never`) is executed. The output replaces or creates the `#+RESULTS:` block immediately below it. These results are then rendered inside a styled `<div class="results">` in the HTML.

---

## #+INCLUDE: Single Source of Truth

`#+INCLUDE` pulls another file's content into the current document at export time. The included file is never published on its own as a standalone page — it only appears as embedded content inside whatever pages include it.

**Basic usage**

```org
#+INCLUDE: "fibonacci.org" :minlevel 2
```

**What `:minlevel 2` does**

It demotes all headings in the included file by one level. So a `* Heading` in the snippet becomes `** Heading` inside the including page, nesting it naturally as a subsection. Without `:minlevel`, heading levels from the snippet and the host document can clash.

**Including the same snippet in multiple pages**

```org
# In algorithms/index.org:
#+INCLUDE: "fibonacci.org" :minlevel 2

# In cs-fundamentals/index.org:
#+INCLUDE: "../algorithms/fibonacci.org" :minlevel 2
```

Both pages render the same content. Edit `fibonacci.org` once and both update on the next build.

**Including a specific section only**

```org
#+INCLUDE: "large-file.org::*Results" :only-contents t :minlevel 2
```

`::*Results` targets just the heading named "Results" and its subtree. `:only-contents t` strips the heading line itself, including only the content beneath it.

**Including specific lines**

```org
#+INCLUDE: "data.org" :lines "10-25"
```

---

## Emacs Interactive Commands

These commands work when you have a `.org` file open in Emacs. They are for interactive editing and testing — the batch build does not require you to know them.

| Keys | Context | What it does |
|---|---|---|
| `TAB` | On a heading | Cycle fold state: folded → children visible → fully open |
| `S-TAB` | Anywhere | Cycle global fold state for the whole document |
| `C-c C-c` | On a `#+begin_src` block | Execute the block and insert/update `#+RESULTS:` below it |
| `C-c '` | On a `#+begin_src` block | Open the block in a dedicated buffer with full language mode |
| `C-c C-x C-v` | Anywhere | Toggle inline display of images |
| `C-c C-l` | Anywhere | Insert or edit a link interactively |
| `C-c C-o` | On a link | Open the link (file, URL, etc.) |
| `C-c C-e h h` | Anywhere | Export the current file to HTML (opens in browser) |
| `C-c C-e` | Anywhere | Open the full export dispatcher menu |
| `M-RET` | On a heading or list | Insert a new item at the same level |
| `M-RIGHT` / `M-LEFT` | On a heading | Demote / promote the heading one level |
| `C-c C-t` | On a heading | Cycle TODO state (TODO → DONE → blank) |

> **Note on keybindings:** If you use Doom Emacs or Spacemacs, many of these are remapped. `C-c` actions are typically under `SPC m` in Doom. The underlying commands are the same; only the key sequences differ.

---

## How to Add a New Snippet

A snippet is a single `.org` file covering one concept. It lives inside a subject folder and gets pulled into that folder's `index.org`.

**1. Create the file**

```bash
# Example: adding a binary search snippet to Algorithms
touch content/algorithms/binary-search.org
```

**2. Write the snippet**

```org
#+TITLE: Binary Search
#+OPTIONS: toc:nil num:nil

* Binary Search

Searches a sorted list in O(log n) time by repeatedly halving the search space.

#+NAME: binary-search
#+begin_src python :results output
def binary_search(arr, target):
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1

data = list(range(0, 100, 5))
print(f"List: {data}")
print(f"Index of 35: {binary_search(data, 35)}")
print(f"Index of 99: {binary_search(data, 99)}")
#+end_src
```

**3. Include it in the section's index**

Open `content/algorithms/index.org` and add:

```org
* Searching

#+INCLUDE: "binary-search.org" :minlevel 2
```

**4. Rebuild**

```bash
emacs --batch -l publish.el -f org-publish-all
```

The snippet now appears as a subsection of the Algorithms tab. It also has its own standalone page at `/algorithms/binary-search.html`.

---

## How to Add a New Tab / Section

**1. Create the folder and index page**

```bash
mkdir content/physics
```

Create `content/physics/index.org`:

```org
#+TITLE: Physics
#+OPTIONS: toc:2 num:nil

* Classical Mechanics

#+INCLUDE: "newtons-laws.org" :minlevel 2
```

**2. Add the tab link to `publish.el`**

Open `publish.el` and find the `wiki-preamble` variable. Add a new `<a>` tag:

```elisp
(defvar wiki-preamble
  "...
  <nav>
    <a href=\"/index.html\">Home</a>
    <a href=\"/algorithms/index.html\">Algorithms</a>
    <a href=\"/ai/index.html\">AI</a>
    <a href=\"/linear-algebra/index.html\">Linear Algebra</a>
    <a href=\"/statistics/index.html\">Statistics</a>
    <a href=\"/physics/index.html\">Physics</a>   ← add this line
  </nav>
  ...")
```

This is the only file that needs to change — `org-publish` discovers the new folder automatically because `:recursive t` is set.

**3. Rebuild**

```bash
emacs --batch -l publish.el -f org-publish-all
```

The Physics tab appears in the nav bar on every page.

---

## Citations & Bibliography

Citations use Org's built-in `org-cite` system, backed by a single shared
`main.bib` at the repo root. There is no per-page `#+bibliography:` keyword to
maintain — `publish.el` points every page at `main.bib` globally, and renders
citations/bibliographies in numeric style (`(1)`, `(2, 3)`, ...).

**Adding a reference to a page**

```org
This idea comes from Koller and Friedman [cite:@kollerBook].

Multiple sources at once: [cite:@perreaultPhD;@perreaultPBL]
```

The `@key` must match a BibTeX entry key in `main.bib`.

**Printing the bibliography**

End any page that cites something with:

```org
* References

#+print_bibliography:
```

At export time, `#+print_bibliography:` is replaced with a numbered list of
every reference cited on that page, resolved from `main.bib`.

**Adding a new source**

Add a BibTeX entry to `main.bib` (any standard entry type — `@book`,
`@article`, `@inproceedings`, `@phdthesis`, etc.) with a unique key, then cite
it with `[cite:@key]` from any page.

**Editing interactively in Emacs**

`.dir-locals.el` at the repo root points `org-cite-global-bibliography` at
`main.bib` for interactive buffers too, so `C-c C-x C-@` inserts a citation
via completion, and following a `[cite:@key]` link (`C-c C-o`) jumps to its
entry in `main.bib`. The first time you open a file in this repo after this
was added, Emacs will ask once whether to trust that `.dir-locals.el` — answer
yes (it only sets a variable, no arbitrary code runs beyond that).

**Editing interactively in Neovim**

Two LuaSnip snippets (Tab/`<C-n>`-expanded, not auto-firing) cover the same
syntax: `cite` inserts `[cite:@key]`, and `refs` inserts the `* References` /
`#+print_bibliography:` footer. See the [Org Cheatsheet](/org-cheatsheet/index.html)
page's "Citations" section for the full trigger table.

Neovim can also export a page straight to PDF (`<Space>oe`), independent of
this site's HTML build. `nvim/scripts/org-pdf-export.el` wires up the
`natbib` citation processor for that export path (plain `bibtex`, run
automatically as an extra `latexmk` pass — no `biber` install needed) and
points it at the same repo-root `main.bib`, so no per-page setup is required
there either. One gotcha: citing a key that isn't in `main.bib` yet doesn't
error — `latexmk` still produces a PDF, but the in-text mark silently renders
as `[?]`, so it's worth glancing at the reference list after exporting.

---

## Building the Site

**Standard build** (only rebuilds files that changed since the last build):

```bash
emacs --batch -l publish.el -f org-publish-all
```

**Force full rebuild** (re-executes all Babel blocks, regenerates all HTML):

```bash
emacs --batch -l publish.el --eval "(org-publish-all t)"
```

Use the force rebuild when you change `publish.el` or `style.css`, since those changes don't modify the `.org` source files and won't trigger an incremental rebuild.

**Serve the output:**

```bash
python3 -m http.server 8080 --directory public/
```

Then open `http://localhost:8080`.

---

## Initial Project Setup Notes

> These notes document how this repo was bootstrapped from scratch. Keep for reference when starting future Nix projects.

First steps, create a flake.nix file, open it, hit `space y y`, then use the snippet `basic-flake`.
Next, create a .envrc file, and use `space y y` to get the `envrc` snippet.
Save them, then use `direnv allow` within the repo. You may get an error since flake.nix isn't added to the github repo. Fix that, then test `direnv allow` is working by typing `hello` into the console. Nice!
