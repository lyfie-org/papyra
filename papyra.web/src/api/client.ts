import axios from 'axios';

const client = axios.create({
  baseURL: 'http://localhost:5220',
  withCredentials: true, // required for SignalR cookie-based auth / CORS credentials
  headers: { 'Content-Type': 'application/json' },
});

export default client;
