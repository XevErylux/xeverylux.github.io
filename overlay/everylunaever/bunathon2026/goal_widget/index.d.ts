/// <reference path="../../../../shared/turso/index.d.ts" />

type EncryptedConfig = typeof import('./config.json');

/**
 * - points: json_basket mit "key" auf 'points' -> { "total": 1499.7 }
 * - goals:  Die goals-Tabelle, über das Dashboard verwaltet
 */
type DataAccess = {
    /** Die Gesamtpunktzahl oder null wenn sich nichts geändert hat. */
    readPoints(): Promise<number | null>,
    /** null wenn sich die goals-Tabelle nicht geändert hat */
    readGoals(): Promise<Goal[] | null>,
    /** Gibt immer die volle goals-Liste zurück. Wird für den ersten Abruf verwendet. */
    readGoalsNow(): Promise<Goal[]>,
};
