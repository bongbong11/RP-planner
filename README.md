# RP Planner

SillyTavern용 RP 일정 관리 확장이다. v3.4.0부터 채팅별 일정을 전용 폴더에 저장하는 서버 플러그인을 함께 제공한다.

## 화면 확장 설치

SillyTavern의 확장 설치 화면에서 이 저장소 URL을 사용한다.

`https://github.com/bongbong11/RP-planner`

## 전용 폴더 저장 활성화

SillyTavern 루트 폴더에서 저장소를 서버 플러그인 폴더에도 한 번 복제한다.

```bash
git clone https://github.com/bongbong11/RP-planner.git plugins/RP-planner-storage
```

`config.yaml`에서 다음 값을 켠 뒤 SillyTavern 서버를 재시작한다.

```yaml
enableServerPlugins: true
```

저장 경로:

```text
data/<사용자명>/RP-planner/chats/chat_<채팅해시>.json
```

- 채팅마다 JSON 파일 하나를 사용한다.
- 같은 캐릭터의 다른 채팅과 데이터가 섞이지 않는다.
- 현재 채팅의 일정 전체 초기화 시 해당 JSON 파일이 삭제된다.
- 기존 `settings.json`의 RP Planner 채팅 데이터는 채팅을 처음 열 때 옮겨지고 기존 레코드는 제거된다.
- 서버 플러그인이 없거나 꺼져 있으면 데이터 손실을 막기 위해 기존 `settings.json` 저장으로 임시 전환된다.
