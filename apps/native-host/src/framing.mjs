/**
 * Chrome Native Messaging 프레이밍.
 * 한 메시지 = 4바이트 리틀엔디안 길이 + UTF-8 JSON. 메시지 하나당 1MB 상한이 있다.
 */

export function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * 스트림 조각을 모아 완성된 메시지만 꺼내는 디코더를 만든다.
 * stdin 은 메시지 경계와 무관하게 잘려 들어오므로 남은 조각을 들고 있어야 한다.
 */
export function createDecoder(onMessage) {
  let buffer = Buffer.alloc(0);
  return function feed(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        continue; // 깨진 메시지 하나 때문에 채널을 끊지 않는다.
      }
      onMessage(parsed);
    }
  };
}
