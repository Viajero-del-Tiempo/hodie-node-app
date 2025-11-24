import fetch from 'node-fetch';


export const loadImageFromUrl = async (url) => {
  const res = await fetch(url);
  return Buffer.from(await res.arrayBuffer());
};
