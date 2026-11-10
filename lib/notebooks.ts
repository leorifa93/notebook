/**
 * Notebooks.
 *
 * Die Demo kennt genau ein Notebook. Die ID steht fest in db/schema.sql
 * (`INSERT … ON CONFLICT DO NOTHING`), deshalb muss der Code sie nicht
 * nachschlagen. Ein Notebook-Umschalter ist bewusst nicht Teil von Schritt 2.
 */

export const DEFAULT_NOTEBOOK_ID = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_NOTEBOOK_TITLE = "Demo";
