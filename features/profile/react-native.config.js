/**
 * Re.Pack 이 Metro 를 대신하도록 CLI 명령을 등록한다.
 * 이 파일이 없으면 `react-native webpack-bundle` 대신 Metro 가 돌고,
 * Module Federation 설정이 에러 없이 통째로 무시된다.
 */
module.exports = {
  commands: require('@callstack/repack/commands/rspack'),
};
