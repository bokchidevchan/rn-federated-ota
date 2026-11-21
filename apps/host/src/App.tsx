import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { FEATURES } from './features';
import { OTA } from './ota/config';
import type { FeatureEntry, FeatureModule } from './ota/loadFeature';
import { loadFeature } from './ota/loadFeature';
import type { OtaSession } from './ota/session';
import { getSession, setUserId } from './ota/session';

/**
 * 호스트 셸 화면. 이 코드는 앱에 내장된 번들에 있다.
 * 각 피처 화면은 여기 없고, 버튼을 누르면 이번 세션에 정해진 릴리스를 CDN 에서 받는다.
 *
 * userId 는 네이티브가 initialProps 로 넘긴다(MainActivity). 실제 앱이라면
 * 로그인 id 나 설치 id 자리다. 검증 때는 adb 로 값을 바꿔 가며 카나리 버킷을 본다.
 */
export default function App({ userId = 'user-1' }: { userId?: string }) {
  const [session, setSession] = useState<OtaSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const start = () => {
    setSessionError(null);
    getSession().then(setSession, (e: Error) => setSessionError(e.message));
  };

  useEffect(() => {
    setUserId(userId);
    start();
  }, [userId]);

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Text style={s.title}>rn-federated-ota</Text>
      <View style={s.meta}>
        <Meta k="user" v={userId} />
        <Meta k="channel" v={OTA.channel} />
        <Meta k="runtime" v={OTA.runtimeVersion} />
      </View>

      {sessionError ? (
        <View style={s.card}>
          <Text style={s.error}>resolve 실패: {sessionError}</Text>
          <Button label="다시 시도" onPress={start} />
        </View>
      ) : !session ? (
        <ActivityIndicator style={s.spinner} />
      ) : (
        FEATURES.map(f => <FeatureSlot key={f.name} entry={f} session={session} />)
      )}
    </ScrollView>
  );
}

type SlotState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; mod: FeatureModule; ms: number }
  | { status: 'error'; message: string };

/** 피처 하나의 로드 상태. 피처끼리 독립이라 하나가 실패해도 다른 것은 뜬다. */
function FeatureSlot({ entry, session }: { entry: FeatureEntry; session: OtaSession }) {
  const [state, setState] = useState<SlotState>({ status: 'idle' });
  const resolution = session.features[entry.name] ?? null;

  const open = () => {
    const retry = state.status === 'error';
    const t0 = Date.now();
    setState({ status: 'loading' });
    loadFeature(entry, retry).then(
      mod => {
        const ms = Date.now() - t0;
        console.log(`[OTA] mounted ${entry.name} ${resolution?.releaseId} ${mod.RELEASE_LABEL ?? ''} ${ms}ms`);
        setState({ status: 'ready', mod, ms });
      },
      (e: Error) => {
        // 원문(federation 런타임의 내부 정보)은 로그로만 남기고, 화면에는 사용자 문구만.
        console.log(`[OTA] load failed ${entry.name}`, e.message);
        setState({ status: 'error', message: '화면을 받지 못했습니다. 연결을 확인하고 다시 시도해 주세요.' });
      },
    );
  };

  const Screen = state.status === 'ready' ? state.mod.default : null;

  return (
    <View style={s.card} testID={`slot-${entry.name}`}>
      <View style={s.row}>
        <Text style={s.h2}>{entry.title}</Text>
        <Text style={[s.track, resolution?.track === 'canary' && s.canary]}>
          {resolution ? resolution.track : 'unavailable'}
        </Text>
      </View>
      <Text style={s.small}>{resolution ? resolution.releaseId : '이 런타임에 맞는 릴리스 없음'}</Text>

      {state.status === 'idle' && resolution && <Button label="열기" onPress={open} testID={`open-${entry.name}`} />}
      {state.status === 'loading' && <ActivityIndicator />}
      {state.status === 'error' && (
        <>
          <Text style={s.error}>{state.message}</Text>
          <Button label="다시 시도" onPress={open} />
        </>
      )}
      {Screen && (
        <View style={s.remote}>
          <Text style={s.small}>
            {state.status === 'ready' ? `${state.mod.RELEASE_LABEL ?? ''}, ${state.ms}ms` : ''}
          </Text>
          <Screen userId={session.userId} />
        </View>
      )}
    </View>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <Text style={s.small}>
      <Text style={s.metaKey}>{k} </Text>
      {v}
    </Text>
  );
}

function Button({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable style={s.button} onPress={onPress} testID={testID}>
      <Text style={s.buttonText}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, gap: 14 },
  title: { fontSize: 22, fontWeight: '700', color: '#111' },
  meta: { gap: 2 },
  metaKey: { color: '#888' },
  card: { borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 10, padding: 14, gap: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  h2: { fontSize: 17, fontWeight: '600', color: '#111' },
  track: { fontSize: 12, color: '#555', borderWidth: 1, borderColor: '#ccc', borderRadius: 4, paddingHorizontal: 6 },
  canary: { color: '#000', borderColor: '#000', fontWeight: '700' },
  small: { fontSize: 12, color: '#555' },
  error: { color: '#b00020' },
  spinner: { marginTop: 40 },
  remote: { borderTopWidth: 1, borderTopColor: '#eee', paddingTop: 8, gap: 6 },
  button: { backgroundColor: '#111', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
});
