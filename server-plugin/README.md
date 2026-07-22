# RP Planner Storage 설치

1. 이 `server-plugin` 폴더를 SillyTavern의 `plugins/RP-planner-storage`로 복사한다.
2. SillyTavern `config.yaml`에서 `enableServerPlugins: true`로 설정한다.
3. SillyTavern 서버를 재시작한다.

일정은 로그인한 사용자별로 다음 위치에 저장된다.

`data/<사용자명>/RP-planner/chats/chat_<채팅해시>.json`

현재 채팅의 일정 전체 초기화를 실행하면 해당 JSON 파일도 삭제된다.
