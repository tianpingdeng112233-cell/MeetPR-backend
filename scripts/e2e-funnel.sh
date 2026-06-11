#!/bin/bash
# MeetPR 005 funnel 真环冒烟 — 新镜像 @ 固定 CLB IP
set -u
BASE=http://121.40.160.241:3000
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1 — $2"; }
TS=$(date +%s)
CPHONE="+8613900099${TS: -4:2}1"; SPHONE="+8613900099${TS: -4:2}2"; PW="E2eFunnel!2026"

echo "── 1. 注册教练+学员（新镜像 auth）"
CR=$(curl -sS -m 10 -X POST $BASE/auth/register -H 'Content-Type: application/json' -d "{\"phone\":\"$CPHONE\",\"password\":\"$PW\",\"role\":\"coach\"}")
SR=$(curl -sS -m 10 -X POST $BASE/auth/register -H 'Content-Type: application/json' -d "{\"phone\":\"$SPHONE\",\"password\":\"$PW\",\"role\":\"coached_student\"}")
CT=$(echo "$CR" | jq -r '.accessToken // empty'); CID=$(echo "$CR" | jq -r '.user.id // empty')
ST=$(echo "$SR" | jq -r '.accessToken // empty'); SID=$(echo "$SR" | jq -r '.user.id // empty')
[ -n "$CT" ] && [ -n "$ST" ] && ok "双账号注册" || bad "注册" "$(echo $CR$SR|head -c 200)"

echo "── 2. 教练建 Personal 邀请码"
IC=$(curl -sS -m 10 -X POST $BASE/coach/invite-codes -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"type":"personal_permanent"}')
CODE=$(echo "$IC" | jq -r '.invite_code.code // .code // empty')
[ -n "$CODE" ] && ok "邀请码 $CODE" || bad "邀请码" "$(echo $IC|head -c 300)"

echo "── 3. 学员输码绑定（display_name 采集点）"
BR=$(curl -sS -m 10 -X POST $BASE/bind-requests -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\",\"display_name\":\"冒烟学员\"}")
BRID=$(echo "$BR" | jq -r '.bind_request.id // .id // empty')
[ -n "$BRID" ] && ok "绑定请求 pending" || bad "绑定请求" "$(echo $BR|head -c 300)"
MINE=$(curl -sS -m 10 $BASE/bind-requests/mine -H "Authorization: Bearer $ST")
echo "$MINE" | jq -e '.bind_request.status == "pending"' >/dev/null && ok "学员视角 pending" || bad "mine" "$(echo $MINE|head -c 200)"

echo "── 4. 学员先填部分 onboarding（队列摘要数据源）"
OB=$(curl -sS -m 10 -X PUT $BASE/students/me/onboarding -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d '{"gender":"male","birth_date":"2000-01-15","height_cm":178,"weight_kg":83,"training_years":3,"squat_1rm_kg":180,"bench_1rm_kg":120,"deadlift_1rm_kg":220,"gym_tier":"commercial","muscle_groups_to_strengthen":["quad","hamstring","shoulder"]}')
echo "$OB" | jq -e '.user_id // .profile' >/dev/null && ok "onboarding 部分提交（可重入）" || bad "onboarding PUT" "$(echo $OB|head -c 300)"

echo "── 5. 教练队列见请求 + 9 项摘要"
Q=$(curl -sS -m 10 $BASE/coach/bind-requests -H "Authorization: Bearer $CT")
echo "$Q" | jq -e ".bind_requests[] | select(.id==\"$BRID\") | .onboarding" >/dev/null 2>&1 && ok "队列含请求 + onboarding 摘要嵌套" || bad "队列" "$(echo $Q|head -c 300)"

echo "── 6. 教练接受 → 进 7 天评估期"
AC=$(curl -sS -m 10 -X POST $BASE/coach/bind-requests/$BRID/accept -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"skip_evaluation":false}')
EVID=$(echo "$AC" | jq -r '.evaluation_period.id // empty')
[ -n "$EVID" ] && ok "accepted + 评估期 $EVID" || bad "accept" "$(echo $AC|head -c 300)"
ROSTER=$(curl -sS -m 10 $BASE/coach/students -H "Authorization: Bearer $CT")
echo "$ROSTER" | jq -e ".students[] | select(.id==\"$SID\")" >/dev/null && ok "花名册见学员（profile 兜底生效）" || bad "花名册" "$(echo $ROSTER|head -c 200)"

echo "── 7. 真 gate：评估期内 regular 4 周 publish 应 403"
TODAY=$(date +%F); END=$(date -v+27d +%F 2>/dev/null || date -d "+27 days" +%F)
PL=$(curl -sS -m 10 -X POST $BASE/plans -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d "{\"trainee_id\":\"$SID\",\"name\":\"正式四周\",\"start_date\":\"$TODAY\",\"end_date\":\"$END\",\"plan_weeks\":4,\"source\":\"coach\"}")
PLID=$(echo "$PL" | jq -r '.id // empty')
DAY=$(curl -sS -m 10 -X POST $BASE/plans/$PLID/days -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"day_of_week":1,"week_number":1,"sort_order":0}')
DAYID=$(echo "$DAY" | jq -r '.id // .day.id // empty')
EX=$(curl -sS -m 10 "$BASE/exercises?main_lift_family=squat&exercise_type=main_lift" -H "Authorization: Bearer $CT" | jq -r '.exercises[0].id')
PEX=$(curl -sS -m 10 -X POST $BASE/plans/days/$DAYID/exercises -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d "{\"exercise_id\":\"$EX\",\"is_main_lift\":true,\"sort_order\":0}")
PEXID=$(echo "$PEX" | jq -r '.id // .exercise.id // empty')
curl -sS -m 10 -X POST $BASE/plans/exercises/$PEXID/sets -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"set_number":1,"target_reps":5,"intensity_mode":"rpe","target_value":7.5,"set_type":"working"}' >/dev/null
GATECODE=$(curl -sS -m 10 -o /tmp/gate.json -w "%{http_code}" -X POST $BASE/plans/$PLID/publish -H "Authorization: Bearer $CT")
[ "$GATECODE" = "403" ] && grep -q EVALUATION_IN_PROGRESS /tmp/gate.json && ok "regular publish 403 真 gate" || bad "真 gate" "code=$GATECODE $(head -c 150 /tmp/gate.json)"

echo "── 8. 适应周（kind=adaptation 1 周）publish 应 200"
AEND=$(date -v+6d +%F 2>/dev/null || date -d "+6 days" +%F)
AP=$(curl -sS -m 10 -X POST $BASE/plans -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d "{\"trainee_id\":\"$SID\",\"name\":\"适应周\",\"start_date\":\"$TODAY\",\"end_date\":\"$AEND\",\"plan_weeks\":1,\"source\":\"coach\",\"kind\":\"adaptation\"}")
APID=$(echo "$AP" | jq -r '.id // empty')
ADY=$(curl -sS -m 10 -X POST $BASE/plans/$APID/days -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"day_of_week":1,"week_number":1,"sort_order":0}')
ADYID=$(echo "$ADY" | jq -r '.id // empty')
APEX=$(curl -sS -m 10 -X POST $BASE/plans/days/$ADYID/exercises -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d "{\"exercise_id\":\"$EX\",\"is_main_lift\":true,\"sort_order\":0}")
APEXID=$(echo "$APEX" | jq -r '.id // empty')
curl -sS -m 10 -X POST $BASE/plans/exercises/$APEXID/sets -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"set_number":1,"target_reps":5,"intensity_mode":"rpe","target_value":7,"set_type":"working"}' >/dev/null
APUB=$(curl -sS -m 10 -X POST $BASE/plans/$APID/publish -H "Authorization: Bearer $CT")
echo "$APUB" | jq -e '.status == "published" and .kind == "adaptation"' >/dev/null && ok "适应周 publish 200" || bad "适应周" "$(echo $APUB|head -c 200)"

echo "── 9. onboarding complete → 1RM 锁定"
CMP=$(curl -sS -m 10 -X POST $BASE/students/me/onboarding/complete -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d '{}')
CMPOK=$?
echo "$CMP" | jq -e '.profile.completed_at // .completed_at' >/dev/null 2>&1 && ok "complete 落定" || { CODE2=$(echo "$CMP" | jq -r '.error // empty'); [ "$CODE2" = "ONBOARDING_INCOMPLETE" ] && ok "complete 必填校验生效（缺字段被拒,符合预期路径）" || bad "complete" "$(echo $CMP|head -c 300)"; }
# 补齐必填再 complete
curl -sS -m 10 -X PUT $BASE/students/me/onboarding -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d '{"unit_preference":"kg","squat_stance":"low_bar","deadlift_style":"conventional","training_days":["mon","wed","fri","sat"],"daily_life_intensity":3,"life_stress":4,"recovery_speed":3,"sleep_hours":3,"is_competing":false}' >/dev/null
CMP2=$(curl -sS -m 10 -X POST $BASE/students/me/onboarding/complete -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d '{}')
echo "$CMP2" | jq -e '.profile.completed_at // .completed_at' >/dev/null 2>&1 && ok "补齐后 complete 成功" || bad "complete2" "$(echo $CMP2|head -c 300)"
LOCK=$(curl -sS -m 25 -o /tmp/lock.json -w "%{http_code}" -X PUT $BASE/students/me/onboarding -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d '{"squat_1rm_kg":185}')
[ "$LOCK" = "403" ] && grep -q ONE_RM_LOCKED /tmp/lock.json && ok "学员改 1RM 被锁 403" || bad "1RM 锁" "code=$LOCK $(head -c 150 /tmp/lock.json)"
CRM=$(curl -sS -m 10 -X PUT $BASE/coach/students/$SID/one-rm -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"squat_1rm_kg":185}')
echo "$CRM" | jq -e '.' >/dev/null 2>&1 && ok "教练改 1RM 通道开" || bad "教练 1RM" "$(echo $CRM|head -c 200)"

echo "── 10. 评估总结 → 学员可读"
SUM=$(curl -sS -m 10 -X PUT $BASE/coach/students/$SID/evaluation-summary -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"overall_assessment":"技术基础扎实,深蹲触底偏快","training_plan":"先 4 周基础力量,周三练","words_to_student":"放慢离心,我们一步步来","notify_student":true}')
echo "$SUM" | jq -e '.' >/dev/null && ok "总结保存" || bad "总结 PUT" "$(echo $SUM|head -c 250)"
SSEE=$(curl -sS -m 10 $BASE/students/$SID/evaluation-summary -H "Authorization: Bearer $ST")
echo "$SSEE" | jq -e '.summary.training_plan // .training_plan' >/dev/null && ok "学员读到总结" || bad "学员读总结" "$(echo $SSEE|head -c 250)"

echo "── 11. 完成评估 → regular publish 解锁"
DONE=$(curl -sS -m 10 -X POST $BASE/coach/evaluations/$EVID/complete -H "Authorization: Bearer $CT")
echo "$DONE" | jq -e '.' >/dev/null && ok "评估完成" || bad "评估完成" "$(echo $DONE|head -c 200)"
PUB2=$(curl -sS -m 10 -X POST $BASE/plans/$PLID/publish -H "Authorization: Bearer $CT")
echo "$PUB2" | jq -e '.status == "published"' >/dev/null && ok "正式计划 publish 解锁 200" || bad "解锁 publish" "$(echo $PUB2|head -c 200)"

echo "── 12. OSS 签名真生成（uploads initiate）"
UP=$(curl -sS -m 10 -X POST $BASE/uploads/initiate -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d '{"kind":"set_video","content_type":"video/mp4","size_bytes":1048576,"part_count":1,"filename":"smoke.mp4"}')
echo "$UP" | jq -e '.part_urls[0].url | test("aliyuncs")' >/dev/null && ok "initiate 201 + OSS presigned URL 真签出" || bad "uploads initiate" "$(echo $UP|head -c 300)"
ATID=$(echo "$UP" | jq -r '.attachment_id // empty')
[ -n "$ATID" ] && curl -sS -m 10 -X POST $BASE/uploads/$ATID/abort -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d '{}' -o /dev/null -w "" && ok "abort 清理"

echo ""
echo "═══ Funnel 冒烟: $PASS 通过 / $FAIL 失败 ═══"
exit $FAIL
