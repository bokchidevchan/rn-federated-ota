import { AppRegistry } from 'react-native';

// 리졸버를 첫 화면보다 먼저 등록한다. 등록 전에 import() 가 불리면
// Module Federation 이 remotes 의 자리표시자 주소(ota://)로 가려다 실패한다.
import './src/ota/scriptManager';
import App from './src/App';

AppRegistry.registerComponent('OtaHost', () => App);
