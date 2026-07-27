# 백업 알림 서버 배포 가이드

앱을 완전히 꺼둬도 알람이 오도록 하는 서버예요. 전부 무료 티어로 충분하고,
코드는 이미 다 만들어져 있어서 계정 가입 + 값 붙여넣기만 하면 돼요.
전체 소요 시간 15~20분 정도예요.

## 1단계 — Upstash (데이터 저장소, 무료)

1. https://upstash.com 접속 → GitHub 계정으로 가입
2. "Create Database" → 이름은 아무거나(예: shift-alarm) → Region은 가까운 곳(도쿄 등) → Create
3. 생성된 DB 페이지에서 "REST API" 섹션을 찾아 아래 두 값을 복사해둬요:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

## 2단계 — GitHub에 이 `server` 폴더 올리기

Render가 GitHub 저장소를 보고 자동 배포하는 방식이라 필요해요.

1. github.com에서 새 저장소 생성 (Private로 해도 됨, 예: `shift-alarm-server`)
2. 이 프로젝트의 `server` 폴더 내용을 그 저장소에 push
   (`.env`, `VAPID_KEYS.txt`는 `.gitignore`에 이미 있어서 자동으로 안 올라가요 — 확인해 주세요)

## 3단계 — Render (서버 호스팅, 무료)

1. https://render.com 접속 → GitHub 계정으로 가입
2. "New +" → "Web Service" → 방금 만든 저장소 선택
3. 설정:
   - Name: 아무거나
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. "Environment" 탭에서 아래 값들을 하나씩 추가:

   | Key | Value |
   |---|---|
   | `VAPID_PUBLIC_KEY` | `VAPID_KEYS.txt` 파일에 적힌 값 |
   | `VAPID_PRIVATE_KEY` | `VAPID_KEYS.txt` 파일에 적힌 값 |
   | `VAPID_SUBJECT` | `mailto:본인이메일@gmail.com` |
   | `UPSTASH_REDIS_REST_URL` | 1단계에서 복사한 값 |
   | `UPSTASH_REDIS_REST_TOKEN` | 1단계에서 복사한 값 |
   | `SYNC_SECRET` | 아무 랜덤 문자열 (예: 비밀번호 생성기로 만든 값) — 앱 설정 화면에도 동일하게 입력할 값 |

5. "Create Web Service" 클릭 → 배포 완료되면 `https://xxxx.onrender.com` 같은 주소가 생겨요. 이 주소를 복사해두세요.

⚠️ Render 무료 티어는 15분간 요청이 없으면 잠들어요(sleep). 아래 4단계의
cron-job.org 핑이 매 분 깨워주기 때문에 실사용에는 문제없지만, 잠들어 있다가
깨어나는 순간에는 몇 초 정도 지연이 생길 수 있어요.

## 4단계 — cron-job.org (서버를 매 분 깨워서 알람 확인시키기, 무료)

1. https://cron-job.org 접속 → 가입
2. "Create cronjob"
3. URL: `https://your-app.onrender.com/tick` (3단계에서 받은 주소 + `/tick`)
4. 실행 주기: **Every minute** (1분마다)
5. 저장

이제 서버가 1분마다 깨어나서 "지금 울려야 할 알람이 있나?"를 확인하고,
있으면 푸시를 보내요.

## 5단계 — 앱에 연결하기

1. `shift_alarm_v3.html`을 열고 설정 탭 → "🔔 백업 알림 서버" 카드로 이동
2. 서버 주소: 3단계에서 받은 `https://xxxx.onrender.com` 입력
3. 동기화 비밀키: 3단계에서 만든 `SYNC_SECRET` 값과 똑같이 입력
4. "저장 및 연결" 클릭
5. "✓ 백업 알림 연결됨" 배지가 뜨면 성공이에요

## 확인하는 법

브라우저에서 `https://xxxx.onrender.com/tick`을 직접 열어보면
`{"ok":true,"devices":1,"sent":0,"failed":0,"pruned":0,"at":"..."}` 같은 JSON이 보여요.
`devices`가 1 이상이면 앱이 서버에 잘 연결된 거예요.

## 나중에 무언가 안 될 때 확인 순서

1. Render 대시보드 → 해당 서비스 → "Logs"에서 에러 확인
2. `/tick`을 직접 열어서 `devices: 0`이면 → 앱에서 알림 권한 허용 + 백업 서버 연결이 안 된 상태
3. `sent`는 늘어나는데 알람이 안 오면 → 안드로이드 배터리 최적화(앱 설정 화면 안내 참고) 또는 iOS 알림 권한 확인
