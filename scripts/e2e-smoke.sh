#!/bin/bash
# MeetPR V0.1 数字环 E2E 冒烟 — 本地 backend + staging RDS
# 用 e2e 专用号段 +86139000099xx；幂等：重跑时注册 409 则改走登录
set -u
BASE=http://localhost:3000
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1 — $2"; }

CPHONE="+8613900009901"; SPHONE="+8613900009902"; CPW="E2eCoach!2026"; SPW="E2eStudent!2026"

echo "── 1. 注册/登录 教练+学员"
reg() { # phone pw role -> access_token \t user_id
  local r=$(curl -sS -m 10 -X POST $BASE/auth/register -H 'Content-Type: application/json' -d "{\"phone\":\"$1\",\"password\":\"$2\",\"role\":\"$3\"}")
  if echo "$r" | jq -e '.accessToken' >/dev/null 2>&1; then echo "$r"; return; fi
  curl -sS -m 10 -X POST $BASE/auth/login -H 'Content-Type: application/json' -d "{\"phone\":\"$1\",\"password\":\"$2\"}"
}
CR=$(reg $CPHONE $CPW coach); SR=$(reg $SPHONE $SPW coached_student)
CT=$(echo "$CR" | jq -r '.accessToken // empty'); CID=$(echo "$CR" | jq -r '.user.id // empty')
ST=$(echo "$SR" | jq -r '.accessToken // empty'); SID=$(echo "$SR" | jq -r '.user.id // empty')
[ -n "$CT" ] && ok "教练 token 取得 ($CID)" || bad "教练注册/登录" "$CR"
[ -n "$ST" ] && ok "学员 token 取得 ($SID)" || bad "学员注册/登录" "$SR"

echo "── 2. refresh 轮换"
CRT=$(echo "$CR" | jq -r '.refreshToken // empty')
RR=$(curl -sS -m 10 -X POST $BASE/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$CRT\"}")
NEWCT=$(echo "$RR" | jq -r '.accessToken // empty')
[ -n "$NEWCT" ] && { CT=$NEWCT; ok "refresh 轮换成功"; } || bad "refresh" "$RR"

echo "── 3. bind（psql 直插模拟 005 上线后状态）"
DBURL=$(grep '^DATABASE_URL=' ~/Projects/apps/MeetPR-backend/.env | cut -d= -f2-)
psql "$DBURL" -q -c "INSERT INTO bind_requests (student_id, coach_id, status, submitted_at, responded_at, expired_at) VALUES ('$SID','$CID','accepted',now(),now(),now()+interval '7 days') ON CONFLICT DO NOTHING;" 2>/dev/null
psql "$DBURL" -q -c "INSERT INTO student_profiles (user_id, display_name) VALUES ('$SID','E2E学员') ON CONFLICT (user_id) DO NOTHING; INSERT INTO coach_profiles (user_id, display_name) VALUES ('$CID','E2E教练') ON CONFLICT (user_id) DO NOTHING;" 2>/dev/null
BIND=$(psql "$DBURL" -t -c "SELECT count(*) FROM bind_requests WHERE student_id='$SID' AND coach_id='$CID' AND status='accepted';" | tr -d ' \n')
[ "$BIND" = "1" ] && ok "bind accepted 就位" || bad "bind 插入" "count=$BIND"

echo "── 4. coach 花名册"
CS=$(curl -sS -m 10 $BASE/coach/students -H "Authorization: Bearer $CT")
echo "$CS" | jq -e ".students[] | select(.id==\"$SID\")" >/dev/null 2>&1 && ok "GET /coach/students 含 e2e 学员" || bad "/coach/students" "$(echo $CS|head -c 200)"

echo "── 5. 动作目录"
EX=$(curl -sS -m 10 "$BASE/exercises?main_lift_family=squat&exercise_type=main_lift" -H "Authorization: Bearer $CT")
SQID=$(echo "$EX" | jq -r '.exercises[0].id // empty')
EXCOUNT=$(curl -sS -m 10 "$BASE/exercises" -H "Authorization: Bearer $CT" | jq '.exercises | length')
[ -n "$SQID" ] && ok "catalog 查询 squat main_lift ($EXCOUNT 条全集)" || bad "catalog" "$(echo $EX|head -c 200)"

echo "── 6. coach 建计划树"
TODAY=$(date +%F); END=$(date -v+27d +%F 2>/dev/null || date -d "+27 days" +%F)
PL=$(curl -sS -m 10 -X POST $BASE/plans -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d "{\"trainee_id\":\"$SID\",\"name\":\"E2E 四周计划\",\"start_date\":\"$TODAY\",\"end_date\":\"$END\",\"plan_weeks\":4,\"source\":\"coach\"}")
PLID=$(echo "$PL" | jq -r '.plan.id // .id // empty')
[ -n "$PLID" ] && ok "POST /plans → $PLID" || bad "POST /plans" "$(echo $PL|head -c 300)"
DAY=$(curl -sS -m 10 -X POST $BASE/plans/$PLID/days -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"day_of_week":1,"week_number":1,"sort_order":0}')
DAYID=$(echo "$DAY" | jq -r '.day.id // .id // empty')
[ -n "$DAYID" ] && ok "POST day → W1 周一" || bad "POST day" "$(echo $DAY|head -c 300)"
PEX=$(curl -sS -m 10 -X POST $BASE/plans/days/$DAYID/exercises -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d "{\"exercise_id\":\"$SQID\",\"is_main_lift\":true,\"sort_order\":0}")
PEXID=$(echo "$PEX" | jq -r '.exercise.id // .id // empty')
[ -n "$PEXID" ] && ok "POST exercise → 深蹲" || bad "POST exercise" "$(echo $PEX|head -c 300)"
SETOK=1
for i in 1 2 3; do
  SE=$(curl -sS -m 10 -X POST $BASE/plans/exercises/$PEXID/sets -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d "{\"set_number\":$i,\"target_reps\":5,\"intensity_mode\":\"rpe\",\"target_value\":7.5,\"set_type\":\"working\"}")
  echo "$SE" | jq -e '.set.id // .id' >/dev/null 2>&1 || { SETOK=0; bad "POST set#$i" "$(echo $SE|head -c 200)"; }
done
[ "$SETOK" = "1" ] && ok "3 组 working set 写入"

echo "── 7. 发布 → 学员可见"
PUB=$(curl -sS -m 10 -X POST $BASE/plans/$PLID/publish -H "Authorization: Bearer $CT")
echo "$PUB" | jq -e '(.plan.status // .status) == "published"' >/dev/null 2>&1 && ok "publish → published" || bad "publish" "$(echo $PUB|head -c 300)"
SPLANS=$(curl -sS -m 10 $BASE/students/$SID/plans -H "Authorization: Bearer $ST")
echo "$SPLANS" | jq -e ".plans[] | select(.id==\"$PLID\")" >/dev/null 2>&1 && ok "学员 GET own plans 见 published" || bad "student plans" "$(echo $SPLANS|head -c 300)"
TREE=$(curl -sS -m 10 $BASE/plans/$PLID -H "Authorization: Bearer $ST")
NSETS=$(echo "$TREE" | jq '[.days[].exercises[].sets[]] | length' 2>/dev/null)
[ "$NSETS" = "3" ] && ok "学员拉全树（3 set）" || bad "plan tree" "sets=$NSETS $(echo $TREE|head -c 200)"

echo "── 8. 学员记组"
LOGOK=1
for i in 0 1; do
  LG=$(curl -sS -m 10 -X POST $BASE/sets/log -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d "{\"plan_exercise_id\":\"$PEXID\",\"set_index\":$i,\"weight_kg\":140,\"reps\":5,\"rpe\":7.5,\"completed\":true}")
  echo "$LG" | jq -e '.log.id // .id' >/dev/null 2>&1 || { LOGOK=0; bad "sets/log #$i" "$(echo $LG|head -c 200)"; }
done
[ "$LOGOK" = "1" ] && ok "学员 log 2 组 (140kg×5 @7.5)"
RELOG=$(curl -sS -m 10 -X POST $BASE/sets/log -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d "{\"plan_exercise_id\":\"$PEXID\",\"set_index\":0,\"weight_kg\":142.5,\"reps\":5,\"rpe\":8,\"completed\":true}")
echo "$RELOG" | jq -e '.log.id // .id' >/dev/null 2>&1 && ok "同 slot 重记 → upsert" || bad "upsert" "$(echo $RELOG|head -c 200)"

echo "── 9. 教练看执行"
TOMORROW=$(date -v+1d +%F 2>/dev/null || date -d "+1 day" +%F)
CSETS=$(curl -sS -m 10 "$BASE/students/$SID/sets?from=$TODAY&to=$TOMORROW" -H "Authorization: Bearer $CT")
NL=$(echo "$CSETS" | jq '.logs | length' 2>/dev/null)
[ "$NL" -ge 2 ] 2>/dev/null && ok "coach 看到 $NL 条 log（含历轮累积，upsert 语义 ok）" || bad "coach sets view" "logs=$NL $(echo $CSETS|head -c 200)"

echo "── 10. 反馈环"
FB=$(curl -sS -m 10 -X POST $BASE/coach/feedback -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d "{\"student_id\":\"$SID\",\"plan_exercise_id\":\"$PEXID\",\"text\":\"E2E:深蹲触底节奏不错，下周加到 145kg\"}")
FBID=$(echo "$FB" | jq -r '.feedback.id // .id // empty')
[ -n "$FBID" ] && ok "coach 发反馈" || bad "coach feedback" "$(echo $FB|head -c 300)"
SFB=$(curl -sS -m 10 $BASE/students/$SID/feedback -H "Authorization: Bearer $ST")
echo "$SFB" | jq -e ".items[] | select(.id==\"$FBID\")" >/dev/null 2>&1 && ok "学员收到反馈" || bad "student feedback inbox" "$(echo $SFB|head -c 300)"
RDCODE=$(curl -sS -m 10 -o /tmp/rd.json -w "%{http_code}" -X PATCH $BASE/feedback/$FBID/read -H "Authorization: Bearer $ST")
[ "$RDCODE" = "200" ] || [ "$RDCODE" = "204" ] && ok "标记已读 ($RDCODE)" || bad "mark read" "code=$RDCODE $(head -c 200 /tmp/rd.json)"

echo "── 11. 越权抽查"
XP=$(curl -sS -m 10 -o /dev/null -w "%{http_code}" -X POST $BASE/plans -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d "{\"trainee_id\":\"$SID\",\"name\":\"x\",\"start_date\":\"$TODAY\",\"end_date\":\"$END\",\"plan_weeks\":4,\"source\":\"coach\"}")
[ "$XP" = "403" ] && ok "学员建计划被 403" || bad "学员建计划应 403" "got $XP"
XS=$(curl -sS -m 10 -o /dev/null -w "%{http_code}" "$BASE/students/$SID/sets?from=$TODAY&to=$TODAY")
[ "$XS" = "401" ] && ok "无 token 401" || bad "无 token 应 401" "got $XS"

echo ""
echo "═══ E2E 结果: $PASS 通过 / $FAIL 失败 ═══"
exit $FAIL
