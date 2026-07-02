// test-axios-fetch.js
const axios = require('axios');

async function test() {
  const url = 'http://localhost:9000/dev-ai-images-generated/generated/cmorf337c000adamw2w6f691b/cmr0adrca000pdacs7qb32hfh.png';
  
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  console.log('Status:', response.status);
  console.log('Bytes received:', response.data.length);
  console.log('Content-Type:', response.headers['content-type']);
}

test().catch(err => console.error('Failed:', err.message));