const { generateInfluencerImage } = require('./visioncraft');

generateInfluencerImage(
  'https://assets.myntassets.com/h_720,q_90,w_540/v1/assets/images/26281552/2024/6/25/56bb3673-9fdb-41aa-9b21-1a794a2ab0f11719292872080-By-The-Bay-Pink-Halter-Neck-Self-Design-Sleeveless-Cotton-Dr-7.jpg'
).then(url => {
  console.log('Result URL:', url);
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});