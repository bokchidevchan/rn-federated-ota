import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

declare const __RELEASE_LABEL__: string;

/** 호스트가 화면 옆에 표시하는 라벨. 어떤 빌드가 떴는지 눈으로 확인하는 용도. */
export const RELEASE_LABEL = `cart ${__RELEASE_LABEL__}`;

const ITEMS = [
  { id: 'a', name: '노트', price: 3000 },
  { id: 'b', name: '펜', price: 1500 },
];

/**
 * 원격으로 배포되는 장바구니 화면. 이 파일은 앱에 들어 있지 않다.
 * useState 가 동작한다는 것 자체가 호스트와 React 인스턴스를 공유한다는 증거다.
 * React 가 두 벌 로드됐다면 여기서 "Invalid hook call" 로 깨진다.
 */
export default function CartScreen({ userId }: { userId: string }) {
  const [count, setCount] = useState<Record<string, number>>({});
  const total = ITEMS.reduce((sum, item) => sum + item.price * (count[item.id] ?? 0), 0);

  return (
    <View style={s.box} testID="cart-screen">
      <Text style={s.label}>{RELEASE_LABEL}</Text>
      {ITEMS.map(item => (
        <View key={item.id} style={s.row}>
          <Text style={s.text}>
            {item.name} {item.price.toLocaleString()}원 x {count[item.id] ?? 0}
          </Text>
          <Pressable
            style={s.plus}
            onPress={() => setCount(c => ({ ...c, [item.id]: (c[item.id] ?? 0) + 1 }))}
            testID={`cart-add-${item.id}`}
          >
            <Text style={s.plusText}>+</Text>
          </Pressable>
        </View>
      ))}
      <Text style={s.total}>
        {userId} 합계 {total.toLocaleString()}원
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  box: { gap: 8 },
  label: { fontSize: 12, fontWeight: '700', color: '#111' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  text: { color: '#222' },
  plus: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: '#111', alignItems: 'center', justifyContent: 'center' },
  plusText: { fontSize: 18, color: '#111' },
  total: { fontWeight: '600', color: '#111' },
});
