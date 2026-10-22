# Hyunbbai Portal UI

## Colours

`portal/public/styles.css`의 CSS 변수를 사용한다. Light/dark 전환은 `html[data-theme]`을 따른다.

| Token | Light | Dark | Usage |
| --- | --- | --- | --- |
| --bg-base | #f4f5f7 | #111923 | 페이지 배경 |
| --surface | #ffffff | #192431 | 카드와 패널 |
| --surface-strong | #ffffff | #202e3d | 모달과 표 |
| --ink-main | #17273b | #e4edf6 | 주요 텍스트 |
| --ink-subtle | #4f667f | #b0c0d1 | 보조 텍스트 |

## Typography

- 본문은 기존 Manrope, 제목은 Space Grotesk, 로그는 IBM Plex Mono를 사용한다.
- 상태 배지와 Jobs 로그 버튼은 0.76rem, line-height 1, 세로 7px·가로 10px 여백을 공유한다.

## Spacing and Alignment

- 기존 화면의 간격을 유지하며 4px, 8px, 12px, 16px 단위로 관련 컨트롤을 정렬한다.
- 헤더의 아이콘 버튼은 38px 정사각형이고, 테마 버튼은 설정 버튼 바로 오른쪽에 둔다.
- 모달 제목·닫기·보조 액션은 작은 화면에서도 겹치거나 밀리지 않아야 한다.
- Jobs 상태·로그·액션은 작업 상태가 달라도 같은 열에 맞춘다. Logs에는 버튼만 둔다.
- 모바일 앱 상세의 네 개 탭은 균등한 두 열에 배치한다.
- PC와 모바일의 light/dark 화면에서 가로 넘침, 컨트롤 겹침, 버튼 및 로그 동작을 검증한다.
