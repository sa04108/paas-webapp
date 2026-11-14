# Hyunbbai Portal UI

## Source of truth

현재 화면은 React + TypeScript로 구현한다. [main.tsx](../portal/client/main.tsx)는 기본 [styles.css](../portal/public/styles.css), React 레이아웃 [react.css](../portal/client/react.css), 최종 테마 [theme.css](../portal/client/theme.css) 순서로 스타일을 불러온다. 디자인 토큰과 최종 색상·글꼴은 `theme.css`를 기준으로 한다.

## Theme and typography

- `html[data-theme="dark"]`가 다크 테마를 선택한다.
- 배경은 `--bg-base`, 카드·패널은 `--surface`와 `--surface-strong`, 테두리는 `--surface-border`를 사용한다.
- 글자는 `--ink-main`, `--ink-subtle`, `--ink-soft`를 사용한다. 중립색을 기본으로 하고 상태·오류에 필요한 색상을 사용한다.
- 본문·제목·폼은 `--font-ui` 시스템 글꼴, 코드·로그·터미널은 `--font-code` 시스템 고정폭 글꼴을 사용한다.
- Hyunbbai 브랜드와 자체 테마를 유지한다. 외부 서비스의 로고·전용 글꼴·UI 코드를 복제하지 않는다.

## Controls and alignment

- 보조 버튼과 링크는 `.ghost-btn`의 공통 정렬·여백·테두리·hover·focus·disabled 스타일을 재사용한다. `.action-btn`과 `.icon-btn`의 작은 크기를 보존한다.
- 테마 버튼은 헤더 설정 버튼 오른쪽에 둔다. 앱 카드의 설정 진입은 톱니 아이콘을 사용한다.
- Jobs의 로그 열에는 버튼만 둔다. 모달 제목·Retry·닫기 버튼을 가운데 정렬하고 작은 화면에서도 겹치지 않게 한다.
- 앱 로그의 서비스 선택은 다중 토글이다. Timestamps는 Lines 입력 왼쪽에 두고 Auto/Refresh 단일 버튼을 유지한다.
- React 구성요소를 수정할 때 데스크톱·모바일과 라이트·다크 테마에서 가로 넘침, 컨트롤 정렬, 키보드 포커스, 로그·터미널 스크롤을 확인한다.
