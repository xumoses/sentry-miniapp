import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { getCurrentScope, getClient } from '@sentry/core';
import { System } from '../src/integrations/system';

// Mock @sentry/core
jest.mock('@sentry/core', () => ({
  getCurrentScope: jest.fn(),
  getClient: jest.fn(),
}));

// Mock crossPlatform
const mockSdk: any = {};

jest.mock('../src/crossPlatform', () => ({
  sdk: jest.fn(() => mockSdk),
}));

describe('System', () => {
  let mockScope: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockScope = {
      setContext: jest.fn(),
      setTag: jest.fn(),
    };
    (getCurrentScope as jest.Mock).mockReturnValue(mockScope);

    // 重置 mockSdk
    Object.keys(mockSdk).forEach((key) => delete mockSdk[key]);
  });

  describe('shared runtime defaults', () => {
    it('does not write system guesses into global scope at setup', () => {
      new System().setupOnce();
      expect(mockScope.setContext).not.toHaveBeenCalled();
      expect(mockScope.setTag).not.toHaveBeenCalled();
    });

    it('delegates contexts/tags to the client provider and preserves explicit fields', async () => {
      const defaults = {
        device: { brand: 'Synthetic', model: 'Device', language: 'en' },
        os: { name: 'macOS', version: '27.0.1' },
        app: { app_version: '2.4.0' },
      };
      const client = { getOptions: () => ({}), getRuntimeContexts: jest.fn(async () => defaults) };
      const event = await new System().processEvent(
        { contexts: { os: { name: 'Explicit' } }, tags: { 'app.version': 'explicit' } },
        {},
        client as any,
      );
      expect(event.contexts?.os).toEqual({ name: 'Explicit', version: '27.0.1' });
      expect(event.contexts?.device).not.toHaveProperty('arch');
      expect(event.contexts?.os).not.toHaveProperty('kernel_version');
      expect(event.tags?.['app.version']).toBe('explicit');
      expect(event.tags?.['os.name']).toBe('Explicit');
      expect(mockScope.setContext).not.toHaveBeenCalled();
      expect(client.getRuntimeContexts).toHaveBeenCalledTimes(1);
    });

    it('honors disabled system collection and fails open for unavailable providers', async () => {
      const getRuntimeContexts = jest.fn(async () => {
        throw new Error('unavailable');
      });
      const disabled = { getOptions: () => ({ enableSystemInfo: false }), getRuntimeContexts };
      (getClient as jest.Mock).mockReturnValueOnce(disabled);
      mockSdk.getLocation = jest.fn();
      new System().setupOnce();
      expect(mockSdk.getLocation).not.toHaveBeenCalled();
      expect(await new System().processEvent({ message: 'kept' }, {}, disabled as any)).toEqual({
        message: 'kept',
      });
      expect(getRuntimeContexts).not.toHaveBeenCalled();
      expect(
        await new System().processEvent({ message: 'kept' }, {}, {
          getOptions: () => ({}),
          getRuntimeContexts,
        } as any),
      ).toEqual({ message: 'kept' });
    });
  });

  describe('network context', () => {
    it('should fetch network type when getNetworkType is available', () => {
      mockSdk.getNetworkType = jest.fn();

      const integration = new System();
      integration.setupOnce();

      expect(mockSdk.getNetworkType).toHaveBeenCalledWith(
        expect.objectContaining({
          success: expect.any(Function),
          fail: expect.any(Function),
        }),
      );
    });

    it('should set network context on success', () => {
      mockSdk.getNetworkType = jest.fn((opts: any) => {
        opts.success({ networkType: 'wifi', isConnected: true });
      });

      const integration = new System();
      integration.setupOnce();

      expect(mockScope.setContext).toHaveBeenCalledWith(
        'network',
        expect.objectContaining({
          type: 'wifi',
          connected: true,
        }),
      );
      expect(mockScope.setTag).toHaveBeenCalledWith('network.type', 'wifi');
    });

    it('should handle network type failure gracefully', () => {
      mockSdk.getNetworkType = jest.fn((opts: any) => {
        opts.fail();
      });

      const integration = new System();
      expect(() => integration.setupOnce()).not.toThrow();
    });

    it('should skip network context when getNetworkType is not available', () => {
      const integration = new System();
      expect(() => integration.setupOnce()).not.toThrow();
    });
  });

  describe('location context', () => {
    it('should fetch location when getLocation is available', () => {
      mockSdk.getLocation = jest.fn();

      const integration = new System();
      integration.setupOnce();

      expect(mockSdk.getLocation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'gcj02',
          success: expect.any(Function),
          fail: expect.any(Function),
        }),
      );
    });

    it('should set location context on success', () => {
      mockSdk.getLocation = jest.fn((opts: any) => {
        opts.success({ latitude: 39.9, longitude: 116.4, accuracy: 30 });
      });

      const integration = new System();
      integration.setupOnce();

      expect(mockScope.setContext).toHaveBeenCalledWith(
        'location',
        expect.objectContaining({
          latitude: 39.9,
          longitude: 116.4,
          accuracy: 30,
        }),
      );
    });

    it('should handle location failure gracefully', () => {
      mockSdk.getLocation = jest.fn((opts: any) => {
        opts.fail();
      });

      const integration = new System();
      expect(() => integration.setupOnce()).not.toThrow();
    });
  });

  describe('metadata', () => {
    it('should have correct id and name', () => {
      const integration = new System();
      expect(integration.name).toBe('System');
      expect(System.id).toBe('System');
    });
  });
});
