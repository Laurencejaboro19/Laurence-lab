import { Redirect } from 'expo-router';
import React from 'react';

import { useApp } from '@/state/AppProvider';

export default function Index() {
  const { profile } = useApp();
  return <Redirect href={profile ? '/(tabs)' : '/welcome'} />;
}
