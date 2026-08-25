#!/usr/bin/env bash
# ตัวช่วยติดตั้ง line-secretary-cloudflare แบบทีละขั้น (resume ได้)
#   bash scripts/wizard.sh check     ตรวจ environment อย่างเดียว
#   bash scripts/wizard.sh           เดินทั้งกระบวนการ ข้ามขั้นที่ทำไปแล้ว
#   bash scripts/wizard.sh reset     ล้างสถานะ เริ่มใหม่
#   bash scripts/wizard.sh selftest  ตรวจ logic ของตัว wizard เอง
# ponytail: bash ล้วน ไม่มี dep เพราะต้องรันได้ตั้งแต่ยังไม่มี node_modules (และตรวจว่ามี node ไหม)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
STATE=".generated/wizard-state"
NODE_MIN="20.19.0"
NPM_MIN="10.0.0"

# ---------- output ----------
b=$'\033[1m'; g=$'\033[32m'; y=$'\033[33m'; r=$'\033[31m'; c=$'\033[36m'; n=$'\033[0m'
hr(){ printf '%s\n' "────────────────────────────────────────────────────────"; }
say(){ printf '%b\n' "$*"; }
ok(){ printf '  %s✓%s %s\n' "$g" "$n" "$*"; }
warn(){ printf '  %s!%s %s\n' "$y" "$n" "$*"; }
bad(){ printf '  %s✗%s %s\n' "$r" "$n" "$*"; }
head2(){ hr; printf '%s%s%s\n' "$b" "$*" "$n"; hr; }

have(){ command -v "$1" >/dev/null 2>&1; }
# ver_ge A B → จริงเมื่อ A >= B
ver_ge(){ [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
vnum(){ sed -E 's/^[^0-9]*([0-9]+(\.[0-9]+)*).*/\1/' <<<"${1:-0}"; }

# ---------- state ----------
mkdir -p .generated
touch "$STATE"
is_done(){ grep -qxF "$1" "$STATE"; }
mark(){ grep -qxF "$1" "$STATE" || printf '%s\n' "$1" >> "$STATE"; }

# รันขั้นตอนหนึ่งขั้น ข้ามถ้าเคยผ่าน หยุด wizard ถ้าพัง
step(){
  local key="$1" label="$2"; shift 2
  if is_done "$key"; then ok "ข้าม (ทำแล้ว): $label"; return 0; fi
  printf '\n%s▶ %s%s\n' "$c" "$label" "$n"
  printf '  $ %s\n' "$*"
  if "$@"; then mark "$key"; ok "ผ่าน: $label"; return 0; fi
  bad "ล้มเหลว: $label"
  say "  แก้แล้วรัน 'bash scripts/wizard.sh' ใหม่ — ขั้นที่ผ่านแล้วจะถูกข้าม"
  exit 1
}

# ---------- บังคับใช้เบราว์เซอร์ในแอป ----------
# ปลอม open/xdg-open ให้ไม่เปิดเบราว์เซอร์ระบบ ทุกลิงก์ต้องไปเปิดใน Claude/Codex app browser
NOBROWSER=""
block_system_browser(){
  NOBROWSER="$(mktemp -d)"
  local sh
  for sh in open xdg-open; do
    cat > "$NOBROWSER/$sh" <<'SHIM'
#!/bin/sh
printf '\n  \033[31m⛔ wizard บล็อกเบราว์เซอร์ระบบไว้\033[0m\n'
printf '     เปิดลิงก์นี้ใน Claude app Browser pane หรือ Codex app browser แทน:\n'
printf '     %s\n\n' "$*"
exit 0
SHIM
    chmod +x "$NOBROWSER/$sh"
  done
  PATH="$NOBROWSER:$PATH"; export PATH
  export BROWSER=echo
  trap 'rm -rf "$NOBROWSER"' EXIT
}

browser_step(){ # browser_step <url> <คำสั่งที่ต้องทำ>
  local url="$1"; shift
  printf '\n%s╔══ ขั้นที่ต้องใช้เบราว์เซอร์ ═══════════════════════%s\n' "$y" "$n"
  printf '%s║%s เปิดใน %sClaude app Browser pane%s หรือ %sCodex app browser%s เท่านั้น\n' "$y" "$n" "$b" "$n" "$b" "$n"
  printf '%s║%s ห้ามใช้ Safari/Chrome ปกติ (wizard บล็อก open ไว้แล้ว)\n' "$y" "$n"
  printf '%s║%s\n' "$y" "$n"
  printf '%s║%s  URL: %s%s%s\n' "$y" "$n" "$c" "$url" "$n"
  printf '%s║%s  ทำ: %s\n' "$y" "$n" "$*"
  printf '%s╚═══════════════════════════════════════════════════%s\n' "$y" "$n"
  read -r -p "  ทำเสร็จแล้วกด Enter (พิมพ์ s แล้ว Enter = ข้าม): " a
  [ "$a" = "s" ] && return 1 || return 0
}

wr(){ npx --yes wrangler "$@"; }

# ---------- doctor ----------
DOC_FAIL=0
need(){ # need <cmd> <ทำอะไร> [เวอร์ชันขั้นต่ำ] [คำสั่งดูเวอร์ชัน]
  local cmd="$1" why="$2" min="${3:-}" vcmd="${4:-}"
  if ! have "$cmd"; then bad "$cmd — ไม่พบ ($why)"; DOC_FAIL=1; return; fi
  local v=""; [ -n "$vcmd" ] && v="$(vnum "$(eval "$vcmd" 2>/dev/null | head -1)")"
  if [ -n "$min" ] && [ -n "$v" ] && ! ver_ge "$v" "$min"; then
    bad "$cmd $v — ต้อง >= $min ($why)"; DOC_FAIL=1; return
  fi
  ok "$cmd ${v:+$v }— $why"
}
nice_have(){
  local cmd="$1" why="$2" vcmd="${3:-}"
  if have "$cmd"; then
    local v=""; [ -n "$vcmd" ] && v="$(vnum "$(eval "$vcmd" 2>/dev/null | head -1)")"
    ok "$cmd ${v:+$v }— $why"
  else warn "$cmd — ไม่พบ (ไม่บังคับ: $why)"; fi
}

doctor(){
  head2 "1. ตรวจ environment"

  say "${b}จำเป็นต้องมี${n}"
  need node   "runtime ของ Worker/Vite/tests"     "$NODE_MIN" "node -v"
  need npm    "ติดตั้ง dependencies"               "$NPM_MIN"  "npm -v"
  need npx    "เรียก wrangler"                    ""          ""
  need git    "worktree + deploy จาก branch สะอาด" ""          "git --version"
  need openssl "สุ่ม SESSION_SECRET 32 bytes"      ""          ""
  need curl   "smoke test + LINE webhook API"      ""          "curl --version"

  say ""
  say "${b}มีก็ดี${n}"
  nice_have python3 "สคริปต์ brain.py ของสมองกลาง (โปรเจกต์นี้ไม่ใช้)" "python3 -V"
  nice_have gh      "สร้าง private repo ตอนจบ"                        "gh --version"
  nice_have jq      "อ่าน JSON จาก wrangler ได้สวยขึ้น"                "jq --version"

  say ""
  say "${b}สถานะโปรเจกต์${n}"
  [ -d node_modules ] && ok "node_modules ติดตั้งแล้ว" || warn "node_modules ยังไม่มี — wizard จะรัน npm ci ให้"
  [ -f .dev.vars ] && ok ".dev.vars มีแล้ว (สำหรับ dev local)" || warn ".dev.vars ยังไม่มี — cp .dev.vars.example .dev.vars ถ้าจะ dev ในเครื่อง"
  if have git && git rev-parse --git-dir >/dev/null 2>&1; then
    if [ -z "$(git status --porcelain)" ]; then ok "git worktree สะอาด"
    else warn "git มีไฟล์ค้าง — ควร commit ก่อน deploy production"; fi
  fi

  say ""
  say "${b}Cloudflare${n}"
  if have npx; then
    local who; who="$(wr whoami 2>&1)"
    if grep -qi "not authenticated\|not logged in" <<<"$who"; then
      warn "wrangler ยังไม่ login — wizard จะพาไป login"
    elif grep -qi "account" <<<"$who"; then
      ok "wrangler login แล้ว"
      local dbs; dbs="$(wr d1 list 2>/dev/null)"
      for e in preview production; do
        grep -q "line-secretary-cloudflare-$e" <<<"$dbs" \
          && ok "D1 $e มีแล้ว" || warn "D1 $e ยังไม่มี — wizard จะสร้างให้"
      done
    else
      warn "เรียก wrangler ไม่สำเร็จ (เน็ต/สิทธิ์?) — ลอง: npx wrangler whoami"
    fi
  fi

  say ""
  say "${b}wrangler.jsonc${n}"
  local zero="00000000-0000-0000-0000-000000000000"
  if grep -q "$zero" wrangler.jsonc; then
    warn "ยังมี database_id เป็น UUID ศูนย์ — ต้องรัน configure-cloudflare.mjs ก่อน deploy"
  else ok "database_id ถูกตั้งครบทุก environment"; fi
  grep -q '"LINE_PUSH_ENABLED": "true"' wrangler.jsonc \
    && warn "LINE_PUSH_ENABLED=true อยู่ — ตั้งใจแล้วใช่ไหม (ค่าปลอดภัยคือ false)" \
    || ok "LINE_PUSH_ENABLED=false ทุก env (ปลอดภัย)"

  say ""
  if [ "$DOC_FAIL" = 1 ]; then
    bad "environment ไม่ครบ — ติดตั้งตัวที่ขึ้น ✗ ก่อน"
    say "  macOS: brew install node git gh jq"
    return 1
  fi
  ok "environment ผ่าน"
  return 0
}

# ---------- secrets ----------
put_secret(){ # put_secret NAME env1 [env2...] — อ่านครั้งเดียว ไม่ echo ไม่ลง history
  local name="$1"; shift
  local val
  read -r -s -p "  ใส่ค่า $name (ไม่แสดงบนจอ): " val; echo
  [ -z "$val" ] && { warn "ข้าม $name" >&2; return 1; }
  local e
  for e in "$@"; do
    printf '%s' "$val" | wr secret put "$name" --env "$e" >/dev/null 2>&1 \
      && ok "ตั้ง $name ที่ $e แล้ว" >&2 || bad "ตั้ง $name ที่ $e ไม่สำเร็จ" >&2
  done
  printf '%s' "$val"  # ส่งกลับให้ caller ที่ต้องใช้ต่อ (เช่น curl LINE API)
}

deploy_env(){ # deploy 2 รอบ: รอบแรกได้ URL รอบสองฝัง URL จริงลง DASHBOARD_URL
  local e="$1"
  npm "run" "deploy:$e" | tee ".generated/$e-deploy.log" || return 1
  node scripts/configure-worker-url.mjs "$e" ".generated/$e-deploy.log" || return 1
  npm "run" "deploy:$e" | tee ".generated/$e-deploy-final.log" || return 1
  node scripts/smoke-worker.mjs ".generated/$e-deploy-final.log"
}

worker_url(){
  local f
  for f in ".generated/$1-deploy-final.log" ".generated/$1-deploy.log"; do
    [ -f "$f" ] || continue
    grep -oE 'https://[a-z0-9.-]+\.workers\.dev' "$f" | tail -1 && return 0
  done
}

# ---------- selftest ----------
selftest(){
  local f=0
  ver_ge 22.23.2 20.19.0 || { echo "FAIL ver_ge major"; f=1; }
  ver_ge 20.19.0 20.19.0 || { echo "FAIL ver_ge equal"; f=1; }
  ver_ge 18.20.0 20.19.0 && { echo "FAIL ver_ge older"; f=1; }
  ver_ge 20.9.0  20.19.0 && { echo "FAIL ver_ge minor sort (20.9 < 20.19)"; f=1; }
  [ "$(vnum 'v22.23.2')" = "22.23.2" ] || { echo "FAIL vnum v-prefix"; f=1; }
  [ "$(vnum 'git version 2.39.5 (Apple Git-154)')" = "2.39.5" ] || { echo "FAIL vnum git"; f=1; }
  local t; t="$(mktemp)"; STATE="$t"
  is_done x && { echo "FAIL is_done empty"; f=1; }
  mark x; mark x
  is_done x || { echo "FAIL mark"; f=1; }
  [ "$(wc -l < "$t")" -eq 1 ] || { echo "FAIL mark ซ้ำ"; f=1; }
  rm -f "$t"
  [ "$f" = 0 ] && { echo "selftest: ผ่านทั้งหมด"; return 0; } || return 1
}

# ---------- main ----------
case "${1:-run}" in
  selftest) selftest; exit $? ;;
  reset)    rm -f "$STATE"; ok "ล้างสถานะแล้ว"; exit 0 ;;
  check)    doctor; exit $? ;;
esac

block_system_browser
doctor || exit 1

head2 "2. Dependencies"
[ -d node_modules ] && ok "มีแล้ว" || step deps "ติดตั้ง dependencies" npm ci

head2 "3. Login Cloudflare"
if wr whoami 2>&1 | grep -qi account; then
  ok "login อยู่แล้ว"
else
  say "  wizard จะสั่ง wrangler login แบบ --browser=false — มันจะ${b}พิมพ์ URL ออกมา${n}"
  say "  ให้ก็อป URL นั้นไปเปิดใน ${b}Claude app Browser pane / Codex app browser${n}"
  wr login --browser=false
  wr whoami 2>&1 | grep -qi account || { bad "ยัง login ไม่สำเร็จ"; exit 1; }
  ok "login สำเร็จ"
fi

head2 "4. สร้าง D1 + ผูก database_id"
DBS="$(wr d1 list 2>/dev/null)"
for e in preview production; do
  db="line-secretary-cloudflare-$e"
  if grep -q "$db" <<<"$DBS"; then ok "$db มีแล้ว"; mark "d1-$e"
  else step "d1-$e" "สร้าง D1 $db" wr d1 create "$db" --location apac; fi
  step "cfg-$e" "ผูก database_id ของ $e" node scripts/configure-cloudflare.mjs "$e" "$db"
done

head2 "5. ตรวจโค้ดก่อนขึ้นจริง"
step typecheck "typecheck" npm run typecheck
step tests     "unit + ui tests" npm test

head2 "6. Preview (ปลอดภัย: demo 100 กลุ่ม ไม่มีกลุ่มจริง ไม่ push LINE)"
step mig-preview  "migrate preview" wr d1 migrations apply line-secretary-cloudflare-preview --remote --env preview
step seed-preview "seed demo preview" npm run seed:demo:preview
if ! is_done sec-preview; then
  say "\n${c}▶ ตั้ง secret ของ preview${n}"
  put_secret DASHBOARD_PASSWORD preview >/dev/null
  openssl rand -base64 32 | wr secret put SESSION_SECRET --env preview >/dev/null && ok "สุ่ม SESSION_SECRET ให้แล้ว"
  mark sec-preview
fi
step dep-preview "deploy preview + smoke test" deploy_env preview
PREVIEW_URL="$(worker_url preview)"; [ -n "$PREVIEW_URL" ] && ok "preview: $PREVIEW_URL"

head2 "7. Production (ยังเป็น demo-safe: LINE_PUSH_ENABLED=false)"
step mig-prod  "migrate production" wr d1 migrations apply line-secretary-cloudflare-production --remote --env production
step seed-prod "seed demo production" npm run seed:demo:production
if ! is_done sec-prod; then
  say "\n${c}▶ ตั้ง secret ของ production (ใช้รหัสคนละตัวกับ preview)${n}"
  put_secret DASHBOARD_PASSWORD production >/dev/null
  openssl rand -base64 32 | wr secret put SESSION_SECRET --env production >/dev/null && ok "สุ่ม SESSION_SECRET ให้แล้ว"
  mark sec-prod
fi
step dep-prod "deploy production + smoke test" deploy_env production
PROD_URL="$(worker_url production)"; [ -n "$PROD_URL" ] && ok "production: $PROD_URL"

head2 "8. OpenRouter"
if ! is_done openrouter; then
  browser_step "https://openrouter.ai/keys" "สร้าง API key แล้วก็อปมาวางในขั้นถัดไป (ตั้งวงเงินที่ Settings → Credits ด้วย)" \
    && { put_secret OPENROUTER_API_KEY preview production >/dev/null; mark openrouter; }
fi

head2 "9. LINE Messaging API"
if ! is_done line-console; then
  browser_step "https://developers.line.biz/console/" \
    "สร้าง provider + Messaging API channel → เปิด 'Allow bot to join group chats' → ก็อป Channel secret กับ Channel access token (long-lived) มาเตรียมไว้" \
    && mark line-console
fi

if ! is_done line-secrets; then
  say "\n${c}▶ ใส่ค่าจาก LINE console${n}"
  put_secret LINE_CHANNEL_SECRET preview production >/dev/null
  LINE_TOKEN="$(put_secret LINE_CHANNEL_ACCESS_TOKEN preview production | tail -1)"
  say "  OWNER_USER_ID = LINE user id ของพี่เอง (ขึ้นต้น U...) ดูได้จาก LINE Developers → Basic settings → Your user ID"
  put_secret OWNER_USER_ID preview production >/dev/null
  mark line-secrets
fi

# ตั้ง webhook ผ่าน API แทนการคลิกในหน้าเว็บ — CLI ทำได้ก็ทำ
if ! is_done line-webhook; then
  head2 "10. ตั้ง webhook (ผ่าน LINE API ไม่ต้องคลิกในหน้าเว็บ)"
  if [ -z "$PROD_URL" ]; then
    bad "ยังไม่รู้ URL ของ production (ไม่มี .generated/production-deploy*.log)"
    say "  รัน 'bash scripts/wizard.sh reset' หรือ 'npm run deploy:production' ใหม่ก่อน แล้วค่อยรัน wizard อีกรอบ"
    exit 1
  fi
  if [ -z "${LINE_TOKEN:-}" ]; then
    say "  ต้องใช้ channel access token อีกครั้งเพื่อยิง API (ไม่ถูกเก็บลงไฟล์ ใช้แล้วทิ้ง)"
    read -r -s -p "  ใส่ค่า LINE_CHANNEL_ACCESS_TOKEN (ไม่แสดงบนจอ): " LINE_TOKEN; echo
    [ -z "$LINE_TOKEN" ] && { warn "ข้าม — ตั้ง webhook เองที่ LINE console: $PROD_URL/api/line"; LINE_TOKEN=""; }
  fi
fi
if [ -n "${LINE_TOKEN:-}" ] && ! is_done line-webhook; then
  HOOK="$PROD_URL/api/line"
  curl -sS -X PUT https://api.line.me/v2/bot/channel/webhook/endpoint \
    -H "Authorization: Bearer $LINE_TOKEN" -H "Content-Type: application/json" \
    -d "{\"endpoint\":\"$HOOK\"}" >/dev/null && ok "ตั้ง webhook = $HOOK"
  RES="$(curl -sS -X POST https://api.line.me/v2/bot/channel/webhook/test \
    -H "Authorization: Bearer $LINE_TOKEN" -H "Content-Type: application/json" -d "{\"endpoint\":\"$HOOK\"}")"
  grep -q '"statusCode":200' <<<"$RES" && { ok "verify ผ่าน HTTP 200"; mark line-webhook; } \
    || { bad "verify ไม่ผ่าน: $RES"; say "  ตรวจว่า LINE_CHANNEL_SECRET ที่ใส่ตรงกับ channel เดียวกัน"; }
  unset LINE_TOKEN
fi

head2 "เสร็จแล้ว"
[ -n "$PREVIEW_URL" ] && say "  preview    : $PREVIEW_URL"
[ -n "$PROD_URL" ]    && say "  production : $PROD_URL"
say ""
say "  ${b}ที่ยังต้องทำเอง${n}"
say "  1. เชิญบอทเข้ากลุ่มทดลอง 1 กลุ่ม → ต้องมีข้อความเปิดเผยตัวครั้งเดียว แล้วเงียบ"
say "  2. ส่งข้อความธรรมดา → เช็คว่า dashboard เห็นกิจกรรม แต่บอทไม่ตอบ"
say "  3. ผ่านครบแล้วค่อยเปิด digest: แก้ env.production.vars.LINE_PUSH_ENABLED เป็น \"true\" แล้ว npm run deploy:production"
say "  4. private repo (ถ้าต้องการ): gh repo create gobank01/line-secretary-cloudflare --private --source . --remote origin --push"
say ""
say "  เช็ก environment ซ้ำได้ทุกเมื่อ: bash scripts/wizard.sh check"
