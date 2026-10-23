import { useEffect, useRef } from "react";

// 화면을 떠난 뒤 완료되는 요청이 다른 화면의 상태나 경로를 바꾸지 않게 한다.
export function useRequestScope() {
  const scope = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    return () => controller.abort();
  }, []);
  return scope;
}
