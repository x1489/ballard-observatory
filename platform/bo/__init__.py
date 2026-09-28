"""Ballard Observatory: every public record about Ballard in one lake, and the engines that find patterns in it.

Layers:
  connectors/  pull public sources into the lake (incremental, resumable, personal fields dropped at ingest)
  lake         append-only Parquet batches per dataset + a compacted current table + a manifest with lineage
  views        typed SQL views over the lake (DuckDB), including one unified `events` view
  engines/     baselines, change points, relationships, cascades, hotspots, place intelligence, insights
"""
__version__ = "0.1.0"
