#!/usr/bin/env bash
# Push Bridge's auth settings (magic link + branded email) to a Supabase project.
# `supabase config push` sends a WHOLE config.toml, so this builds a scratch one from `supabase init`
# defaults and only changes [auth]. Fine for the dedicated Bridge project; never point it at a shared one.
#   SITE_URL=https://bridge.thepadelsociety.workers.dev ./auth.sh [project-ref]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ref="${1:-tozuyautmztgolnzgwvg}"
site="${SITE_URL:-https://bridge.thepadelsociety.workers.dev}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp" && supabase init --force >/dev/null
cp "$here/templates/magic_link.html" supabase/magic_link.html
cfg=supabase/config.toml
python3 - "$cfg" "$site" "$ref" <<'PY'
import re, sys
p, site, ref = sys.argv[1:]
s = open(p).read()
s = re.sub(r'^project_id = .*$', f'project_id = "{ref}"', s, count=1, flags=re.M)
s = re.sub(r'^site_url = .*$', f'site_url = "{site}"', s, count=1, flags=re.M)
urls = [site, site + "/**", "http://localhost:4290/**", "http://localhost:4291/**"]
s = re.sub(r'^additional_redirect_urls = .*$', 'additional_redirect_urls = [' + ", ".join(f'"{u}"' for u in urls) + ']', s, count=1, flags=re.M)
s = s.replace('max_frequency = "1s"', 'max_frequency = "60s"', 1)
tpl = '''
[auth.email.template.magic_link]
subject = "Your Bridge sign-in link"
content_path = "./supabase/magic_link.html"

[auth.email.template.confirmation]
subject = "Your Bridge sign-in link"
content_path = "./supabase/magic_link.html"
'''
s = s.replace('# Use a production-ready SMTP server', tpl.strip() + '\n\n# Use a production-ready SMTP server', 1)
open(p, 'w').write(s)
PY
grep -nE '^(project_id|site_url|additional_redirect_urls|enable_signup|max_frequency|subject)' "$cfg"
yes | supabase config push --project-ref "$ref"
