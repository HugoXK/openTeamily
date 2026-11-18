"""The account menu's Help entry opens the guide this repository already serves.

Every shell page's account menu carries a Help submenu. Its first item used to be a disabled
`button` ("帮助中心", tooltip "未实现：OpenTeamily 还没有帮助中心") while `/guide` already existed with
its own search, categories and articles: a dead entry in the shell pages next to a page with no way in.

These tests read the static pages as markup, not through a browser: the entry must be a link to
`/guide` with `role="menuitem"`, the old disabled button must be gone, and a page added later must
carry the same entry or the count check fails.
"""
from html.parser import HTMLParser
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
PAGES = sorted((ROOT / 'openteamily' / 'static').glob('*/index.html'))
DEAD_TOOLTIP = '未实现：OpenTeamily 还没有帮助中心'


class HelpMenu(HTMLParser):
    """Collect the entries of `<div id="help-menu">` as (tag, attrs, text) triples."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.inside = False
        self.depth = 0
        self.entries = []
        self._current = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if self.inside:
            if tag == 'div':
                self.depth += 1
            elif tag in ('a', 'button'):
                self._current = (tag, attrs, '')
        elif tag == 'div' and attrs.get('id') == 'help-menu':
            self.inside = True
            self.depth = 1

    def handle_endtag(self, tag):
        if not self.inside:
            return
        if tag == 'div':
            self.depth -= 1
            if self.depth == 0:
                self.inside = False
        elif tag in ('a', 'button') and self._current and self._current[0] == tag:
            self.entries.append((*self._current[:2], self._current[2].strip()))
            self._current = None

    def handle_data(self, data):
        if self.inside and self._current is not None:
            self._current = (*self._current[:2], self._current[2] + data)


def help_entries(page):
    parser = HelpMenu()
    parser.feed(page.read_text(encoding='utf-8'))
    return parser.entries


class ShellHelpEntryTests(unittest.TestCase):
    def test_every_shell_page_links_the_guide_from_its_help_menu(self):
        self.assertEqual(len(PAGES), 15, f'expected the 15 shell pages, found {[str(p) for p in PAGES]}')
        for page in PAGES:
            with self.subTest(page=page):
                entries = help_entries(page)
                guides = [e for e in entries if e[0] == 'a' and e[1].get('href') == '/guide']
                self.assertEqual(
                    len(guides), 1,
                    f'{page}: the help menu has no single link to /guide: {entries}')
                tag, attrs, text = guides[0]
                self.assertEqual(text, '帮助中心', f'{page}: the guide link is not named 帮助中心: {text!r}')
                self.assertEqual(attrs.get('role'), 'menuitem', f'{page}: the guide link is not a menu item: {attrs}')

    def test_no_shell_page_keeps_the_disabled_help_center_button(self):
        for page in PAGES:
            with self.subTest(page=page):
                entries = help_entries(page)
                dead = [e for e in entries if e[0] == 'button' and '帮助中心' in e[2]]
                self.assertEqual(dead, [], f'{page}: the help entry is still a dead button: {dead}')
                self.assertNotIn(DEAD_TOOLTIP, page.read_text(encoding='utf-8'),
                                 f'{page}: the unimplemented-tooltip is still on the page')


if __name__ == '__main__':
    unittest.main()
