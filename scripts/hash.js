// 관리자 PIN → bcrypt 해시 생성기
//   사용법:  npm run hash -- "원하는PIN"
//   출력된 해시를 환경변수 SIGN_ADMIN_HASH 에 넣으세요(로컬 .env / Railway Variables).
const bcrypt = require('bcryptjs');
const pin = process.argv[2];
if (!pin || !String(pin).trim()) {
  console.error('사용법: npm run hash -- "원하는PIN"');
  process.exit(1);
}
const hash = bcrypt.hashSync(String(pin), 10);
console.log('');
console.log('SIGN_ADMIN_HASH=' + hash);
console.log('');
console.log('위 한 줄을 .env(로컬) 및 Railway Variables 에 그대로 넣으세요.');
