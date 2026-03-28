import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="container">
      <h1>Hyper Extension</h1>
      <p>Hyperliquid Trading Support</p>
      <div className="card">
        <button onClick={() => setCount((c) => c + 1)}>
          Count: {count}
        </button>
      </div>
    </div>
  );
}
