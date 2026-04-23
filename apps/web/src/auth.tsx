import React, { useState, useEffect }

/**
 * AuthProvider handles the Claude API key/token storage and provides
 * authentication state to the rest of the application.
 */
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [apiKey, setApiKey] = useState<string | null>(localStorage.getItem('claude_api_key'));
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(!!localStorage.getItem('claude_api_key'));
  const [inputValue, setInputValue] = useState('');

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      localStorage.setItem('claude_api_key', inputValue.trim());
      setApiKey(inputValue.trim());
      setIsLoggedIn(true);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('claude_api_key');
    setApiKey(null);
    setIsLoggedIn(false);
    setInputValue('');
  };

  if (!isLoggedIn) {
    return (
      <div style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100vh',
        fontFamily: 'sans-serif' 
      }}>
        <div style={{ 
          padding: '2rem', 
          border: '1px solid #ccc', 
          borderRadius: '8px', 
          boxShadow: '0 4px 6px rgba(0,0,0,0.1)' 
        }}>
          <h2>Login with Claude</h2>
          <p>Please enter your Claude API Key to continue</p>
          <form onSubmit={handleLogin}>
            <input 
              type="password" 
              value={inputValue} 
              onChange={(e) => setInputValue(e.target.value)} 
              placeholder="sk-ant-..." 
              style={{ 
                padding: '0.5rem', 
                width: '300px', 
                marginRight: '1rem',
                borderRadius: '4px',
                border: '1px solid #ccc'
              }} 
            />
            <button type="submit" style={{ 
              padding: '0.5rem 1rem', 
              cursor: 'pointer',
              borderRadius: '4px',
              backgroundColor: '#007bff',
              color: 'white',
              border: 'none'
            }}>
              Login
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ apiKey, handleLogout }}>
      {children}
    </AuthContext.Provider>
  );
};

// Create a simple context to expose the API key to components making requests
import { createContext, useContext } from 'react';

const AuthContext = createContext<{ apiKey: string | null; handleLogout: () => void } | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
