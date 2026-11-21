import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

declare const __RELEASE_LABEL__: string;

export const RELEASE_LABEL = `profile ${__RELEASE_LABEL__}`;

/**
 * 원격으로 배포되는 프로필 화면. 장바구니와 다른 팀이 따로 배포한다고 가정한다.
 * 두 피처는 서로를 모르고, 각자 호스트의 공유 스코프에만 의존한다.
 */
export default function ProfileScreen({ userId }: { userId: string }) {
  return (
    <View style={s.box} testID="profile-screen">
      <Text style={s.label}>{RELEASE_LABEL}</Text>
      <Text style={s.name}>{userId}</Text>
      <Text style={s.text}>알림 설정, 주문 내역 같은 화면이 들어갈 자리</Text>
    </View>
  );
}

const s = StyleSheet.create({
  box: { gap: 6 },
  label: { fontSize: 12, fontWeight: '700', color: '#111' },
  name: { fontSize: 18, fontWeight: '600', color: '#111' },
  text: { color: '#555' },
});
