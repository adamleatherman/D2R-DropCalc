#!/usr/bin/env python3
"""Replay of the Diablo II maze (cave) generator, D2MOO D2Common/src/Drlg/DrlgMaze.cpp (LoD 1.10-1.14), to count the cells of every DrlgType 1 level.

Usage:  python -I tools/maze_cells.py [seeds=2000] [level id]     (about 85 s for 2000 seeds; writes tools/maze_cells.json)
        python -I tools/maze_cells.py --trace LEVEL [difficulty] [seed]     (prints one generated level)
Used by build.py (reads maze_cells.json: per level `geo.cells` = populated cells and the expected count of every preset row).  Only the Python
standard library is used.  Reads (read-only) excel/levels.txt, lvlmaze.txt, lvlprest.txt.  The D2MOO sources are NOT needed: the enum values and the
special preset tables of DrlgMaze.cpp / LevelsIds.h that the generator uses are frozen below (PRE, LVL, TABLES), copied from the D2MOO checkout
(https://github.com/ThePhrozenKeep/D2MOO) by a parser; the lvlprest.txt row of an enum value is checked by name in the tests.

Faithful parts (function in DrlgMaze.cpp / DrlgDrlgRoom.cpp):
  rooms             DRLGMAZE_GenerateLevel: first cell, then per LevelType: InitBasicMazeLayout / add-until-Rooms loop / special presets
  adding a cell     DRLGMAZE_AddAdjacentMazeRoom, BuildBasicMaze, PlaceAdjacentPresetRoom, LinkMazeRooms: new cell = parent +- (SizeX|SizeY) in direction
                    0 W,1 N,2 E,3 S (4-7 diagonals); fails only when the box overlaps another cell (DRLG_CheckNotOverlappingUsingManhattanDistance, margin 0)
  no level box      the levels.txt SizeX/SizeY / OffsetX/OffsetY are NOT a bound for maze cells; they only centre the first cell (DRLG_SetLevelPositionAndSize)
  merge             MergeMazeRooms: an edge-adjacent unlinked pair gets linked with probability Merge/1000 (changes the cell's preset mask, not the count)
  presets           PickRoomPreset: base(LevelType) + mask (W=1,E=2,S=4,N=8) with the level type's remapping tables
  specials          ScanReplaceSpecialPreset / ReplaceRoomPreset / AddSpecialPreset / InitRoomFixedPreset: replace the first FREE cell (list order = newest first)
                    whose preset equals the dead-end id, else attach a new cell to the first free cell that has room on the required side
  RollAct_1_2_3_BasicPresets: converts some ordinary cells to themed variants (count unchanged)
  Tal Rasha's tombs DrlgDrlg.cpp picks the staff tomb and the boss tomb among the seven; the calculator lists one merged row for the seven, described
                    as the TRUE tomb (the staff tomb, x3 rooms), so every tomb level is simulated as the staff tomb and the seven results are identical
                    (`tomb_cases` keeps the staff / boss / plain split for level 66 for reference)
Random numbers: python's random.Random(level * 1000 + difficulty) with the same draw structure (& 3 for directions, % Merge-1000 per merge candidate,
random existing cell): deterministic, so the committed maze_cells.json is reproducible.
"""
import csv
import hashlib
import json
import os
import random
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
EXCEL = os.path.join(os.path.dirname(HERE), "excel")
OUT = os.path.join(HERE, "maze_cells.json")


def table(name, folder=None):
    with open(os.path.join(folder or EXCEL, name), encoding="utf-8", errors="replace", newline="") as f:
        return list(csv.DictReader(f, delimiter="	"))


def num(v, d=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return d


# ---------------------------------------------------------------- frozen D2MOO tables (LevelsIds.h, DrlgMaze.cpp)
PRE = {   # D2C_LvlPrestIds (LevelsIds.h): enum value of every preset the generator names; value + 1 past 863 = lvlprest.txt row (see row_of)
    'ACT1_DOE_ENTRANCE': 52,
    'ACT1_CAVE_W': 53,
    'ACT1_CAVE_E': 54,
    'ACT1_CAVE_S': 56,
    'ACT1_CAVE_N': 60,
    'ACT1_CAVE_PREV_W': 83,
    'ACT1_CAVE_PREV_E': 84,
    'ACT1_CAVE_PREV_S': 85,
    'ACT1_CAVE_PREV_N': 86,
    'ACT1_CAVE_NEXT_W': 87,
    'ACT1_CAVE_NEXT_E': 88,
    'ACT1_CAVE_NEXT_S': 89,
    'ACT1_CAVE_NEXT_N': 90,
    'ACT1_CAVE_DOWN_W': 91,
    'ACT1_CAVE_DOWN_E': 92,
    'ACT1_CAVE_DOWN_S': 93,
    'ACT1_CAVE_DOWN_N': 94,
    'ACT1_CAVE_DEN_OF_EVIL_W': 95,
    'ACT1_CAVE_DEN_OF_EVIL_E': 96,
    'ACT1_CAVE_DEN_OF_EVIL_S': 97,
    'ACT1_CAVE_DEN_OF_EVIL_N': 98,
    'ACT1_CAVE_COLDCROW_W': 99,
    'ACT1_CAVE_COLDCROW_E': 100,
    'ACT1_CAVE_COLDCROW_S': 101,
    'ACT1_CAVE_COLDCROW_N': 102,
    'ACT1_GRAVEYARD': 108,
    'ACT1_CRYPT_W': 109,
    'ACT1_CRYPT_E': 110,
    'ACT1_CRYPT_S': 112,
    'ACT1_CRYPT_N': 116,
    'ACT1_CRYPT_PREV_W': 139,
    'ACT1_CRYPT_PREV_E': 140,
    'ACT1_CRYPT_PREV_S': 141,
    'ACT1_CRYPT_PREV_N': 142,
    'ACT1_CRYPT_NEXT_W': 143,
    'ACT1_CRYPT_NEXT_E': 144,
    'ACT1_CRYPT_NEXT_S': 145,
    'ACT1_CRYPT_NEXT_N': 146,
    'ACT1_CRYPT_BONEBREAK_W': 147,
    'ACT1_CRYPT_BONEBREAK_E': 148,
    'ACT1_CRYPT_BONEBREAK_S': 149,
    'ACT1_CRYPT_BONEBREAK_N': 150,
    'ACT1_CRYPT_CHEST_W': 151,
    'ACT1_CRYPT_CHEST_E': 152,
    'ACT1_CRYPT_CHEST_S': 153,
    'ACT1_CRYPT_CHEST_N': 154,
    'ACT1_CRYPT_PORTAL_W': 155,
    'ACT1_CRYPT_PORTAL_E': 156,
    'ACT1_CRYPT_PORTAL_S': 157,
    'ACT1_CRYPT_PORTAL_N': 158,
    'ACT1_BARRACKS_COURT_CONNECT': 167,
    'ACT1_BARRACKS_W': 168,
    'ACT1_BARRACKS_E': 169,
    'ACT1_BARRACKS_S': 171,
    'ACT1_BARRACKS_N': 175,
    'ACT1_BARRACKS_NEXT_W': 198,
    'ACT1_BARRACKS_NEXT_E': 199,
    'ACT1_BARRACKS_NEXT_S': 200,
    'ACT1_BARRACKS_NEXT_N': 201,
    'ACT1_BARRACKS_FORGE_W': 202,
    'ACT1_BARRACKS_FORGE_E': 203,
    'ACT1_BARRACKS_FORGE_S': 204,
    'ACT1_BARRACKS_FORGE_N': 205,
    'ACT1_JAIL_W': 206,
    'ACT1_JAIL_E': 207,
    'ACT1_JAIL_S': 209,
    'ACT1_JAIL_N': 213,
    'ACT1_JAIL_PREV_W': 236,
    'ACT1_JAIL_PREV_E': 237,
    'ACT1_JAIL_PREV_S': 238,
    'ACT1_JAIL_PREV_N': 239,
    'ACT1_JAIL_NEXT_W': 240,
    'ACT1_JAIL_NEXT_E': 241,
    'ACT1_JAIL_NEXT_S': 242,
    'ACT1_JAIL_NEXT_N': 243,
    'ACT1_JAIL_CATH_W': 244,
    'ACT1_JAIL_CATH_E': 245,
    'ACT1_JAIL_CATH_S': 246,
    'ACT1_JAIL_CATH_N': 247,
    'ACT1_JAIL_WAYPOINT_W': 248,
    'ACT1_JAIL_WAYPOINT_E': 249,
    'ACT1_JAIL_WAYPOINT_S': 250,
    'ACT1_JAIL_WAYPOINT_N': 251,
    'ACT1_JAIL_PITSPAWN_W': 252,
    'ACT1_JAIL_PITSPAWN_E': 253,
    'ACT1_JAIL_PITSPAWN_S': 254,
    'ACT1_JAIL_PITSPAWN_N': 255,
    'ACT1_CATHEDRAL': 257,
    'ACT1_CATACOMBS_W': 258,
    'ACT1_CATACOMBS_E': 259,
    'ACT1_CATACOMBS_S': 261,
    'ACT1_CATACOMBS_N': 265,
    'ACT1_CATACOMBS_PREV_EW': 288,
    'ACT1_CATACOMBS_PREV_NS': 289,
    'ACT1_CATACOMBS_PREV_NSEW': 290,
    'ACT1_CATACOMBS_NEXT_W': 291,
    'ACT1_CATACOMBS_NEXT_E': 292,
    'ACT1_CATACOMBS_NEXT_S': 293,
    'ACT1_CATACOMBS_NEXT_N': 294,
    'ACT1_CATACOMBS_WAYPOINT_W': 295,
    'ACT1_CATACOMBS_WAYPOINT_E': 296,
    'ACT1_CATACOMBS_WAYPOINT_S': 297,
    'ACT1_CATACOMBS_WAYPOINT_N': 298,
    'ACT2_TOWN': 301,
    'ACT2_SEWER_W': 302,
    'ACT2_SEWER_E': 303,
    'ACT2_SEWER_S': 305,
    'ACT2_SEWER_N': 309,
    'ACT2_SEWER_PREV_W': 332,
    'ACT2_SEWER_PREV_E': 333,
    'ACT2_SEWER_PREV_S': 334,
    'ACT2_SEWER_PREV_N': 335,
    'ACT2_SEWER_PREV_NS': 336,
    'ACT2_SEWER_NEXT_W': 337,
    'ACT2_SEWER_NEXT_E': 338,
    'ACT2_SEWER_NEXT_S': 339,
    'ACT2_SEWER_NEXT_N': 340,
    'ACT2_SEWER_RADAMENTS_LAIR_W': 341,
    'ACT2_SEWER_RADAMENTS_LAIR_E': 342,
    'ACT2_SEWER_RADAMENTS_LAIR_S': 343,
    'ACT2_SEWER_RADAMENTS_LAIR_N': 344,
    'ACT2_SEWER_WAYPOINT_W': 345,
    'ACT2_SEWER_WAYPOINT_E': 346,
    'ACT2_SEWER_WAYPOINT_S': 347,
    'ACT2_SEWER_WAYPOINT_N': 348,
    'ACT2_SEWER_CHEST_W': 349,
    'ACT2_SEWER_CHEST_E': 350,
    'ACT2_SEWER_CHEST_S': 351,
    'ACT2_SEWER_CHEST_N': 352,
    'ACT2_CORRUPT_HAREM_NE': 354,
    'ACT2_CORRUPT_HAREM_SE': 355,
    'ACT2_CORRUPT_HAREM_SW': 356,
    'ACT2_CORRUPT_HAREM_NW': 357,
    'ACT2_BASEMENT_NE': 358,
    'ACT2_BASEMENT_SE': 359,
    'ACT2_BASEMENT_SW': 360,
    'ACT2_BASEMENT_NW': 361,
    'ACT2_DESERT_RUINS_ELDER': 413,
    'ACT2_TOMB_W': 414,
    'ACT2_TOMB_E': 415,
    'ACT2_TOMB_S': 417,
    'ACT2_TOMB_N': 421,
    'ACT2_TOMB_PREV_SEW': 444,
    'ACT2_TOMB_PREV_NEW': 445,
    'ACT2_TOMB_PREV_NSW': 446,
    'ACT2_TOMB_PREV_NSE': 447,
    'ACT2_TOMB_NEXT_W': 448,
    'ACT2_TOMB_NEXT_E': 449,
    'ACT2_TOMB_NEXT_S': 450,
    'ACT2_TOMB_NEXT_N': 451,
    'ACT2_TOMB_TREASURE_W': 452,
    'ACT2_TOMB_TREASURE_E': 453,
    'ACT2_TOMB_TREASURE_S': 454,
    'ACT2_TOMB_TREASURE_N': 455,
    'ACT2_TOMB_CUBE_W': 456,
    'ACT2_TOMB_CUBE_E': 457,
    'ACT2_TOMB_CUBE_S': 458,
    'ACT2_TOMB_CUBE_N': 459,
    'ACT2_TOMB_TALRASHA_W': 460,
    'ACT2_TOMB_TALRASHA_E': 461,
    'ACT2_TOMB_TALRASHA_S': 462,
    'ACT2_TOMB_TALRASHA_N': 463,
    'ACT2_TOMB_LEATHERARM_W': 464,
    'ACT2_TOMB_LEATHERARM_E': 465,
    'ACT2_TOMB_LEATHERARM_S': 466,
    'ACT2_TOMB_LEATHERARM_N': 467,
    'ACT2_TOMB_KAA_W': 468,
    'ACT2_TOMB_KAA_E': 469,
    'ACT2_TOMB_KAA_S': 470,
    'ACT2_TOMB_KAA_N': 471,
    'ACT2_TOMB_CHEST_W': 472,
    'ACT2_TOMB_CHEST_E': 473,
    'ACT2_TOMB_CHEST_S': 474,
    'ACT2_TOMB_CHEST_N': 475,
    'ACT2_TOMB_WAYPOINT_W': 476,
    'ACT2_TOMB_WAYPOINT_E': 477,
    'ACT2_TOMB_WAYPOINT_S': 478,
    'ACT2_TOMB_WAYPOINT_N': 479,
    'ACT2_TOMB_TAINTED_SUN_X': 480,
    'ACT2_DURIELS_LAIR': 481,
    'ACT2_LAIR_W': 482,
    'ACT2_LAIR_E': 483,
    'ACT2_LAIR_S': 485,
    'ACT2_LAIR_N': 489,
    'ACT2_LAIR_PREV_W': 497,
    'ACT2_LAIR_PREV_E': 498,
    'ACT2_LAIR_PREV_S': 499,
    'ACT2_LAIR_PREV_N': 500,
    'ACT2_LAIR_NEXT_W': 501,
    'ACT2_LAIR_NEXT_E': 502,
    'ACT2_LAIR_NEXT_S': 503,
    'ACT2_LAIR_NEXT_N': 504,
    'ACT2_LAIR_TREASURE_W': 505,
    'ACT2_LAIR_TREASURE_E': 506,
    'ACT2_LAIR_TREASURE_S': 507,
    'ACT2_LAIR_TREASURE_N': 508,
    'ACT2_LAIR_TIGHT_SPOT_S': 509,
    'ACT2_ARCANE_W': 510,
    'ACT2_ARCANE_E': 511,
    'ACT2_ARCANE_S': 513,
    'ACT2_ARCANE_N': 517,
    'ACT2_ARCANE_SUMMONER_W': 525,
    'ACT2_ARCANE_SUMMONER_E': 526,
    'ACT2_ARCANE_SUMMONER_S': 527,
    'ACT2_ARCANE_SUMMONER_N': 528,
    'ACT3_SPIDER_SW': 659,
    'ACT3_SPIDER_SE': 660,
    'ACT3_SPIDER_NW': 661,
    'ACT3_SPIDER_NE': 662,
    'ACT3_SPIDER_CHEST_NW': 663,
    'ACT3_SPIDER_CHEST_NE': 664,
    'ACT3_DUNGEON_W': 665,
    'ACT3_DUNGEON_E': 666,
    'ACT3_DUNGEON_S': 668,
    'ACT3_DUNGEON_N': 672,
    'ACT3_DUNGEON_PREV_W': 695,
    'ACT3_DUNGEON_PREV_E': 696,
    'ACT3_DUNGEON_PREV_S': 697,
    'ACT3_DUNGEON_PREV_N': 698,
    'ACT3_DUNGEON_NEXT_W': 699,
    'ACT3_DUNGEON_NEXT_E': 700,
    'ACT3_DUNGEON_NEXT_S': 701,
    'ACT3_DUNGEON_NEXT_N': 702,
    'ACT3_DUNGEON_TREASURE_2': 704,
    'ACT3_SEWER_W': 705,
    'ACT3_SEWER_E': 706,
    'ACT3_SEWER_S': 708,
    'ACT3_SEWER_SW': 709,
    'ACT3_SEWER_SE': 710,
    'ACT3_SEWER_N': 712,
    'ACT3_SEWER_NW': 713,
    'ACT3_SEWER_NE': 714,
    'ACT3_SEWER_PREV_SW': 735,
    'ACT3_SEWER_PREV_SE': 736,
    'ACT3_SEWER_PREV_NW': 737,
    'ACT3_SEWER_PREV_NE': 738,
    'ACT3_SEWER_DRAIN_W': 739,
    'ACT3_SEWER_DRAIN_E': 740,
    'ACT3_SEWER_DRAIN_S': 741,
    'ACT3_SEWER_DRAIN_N': 742,
    'ACT3_SEWER_CHEST_W': 743,
    'ACT3_SEWER_CHEST_E': 744,
    'ACT3_SEWER_CHEST_S': 745,
    'ACT3_SEWER_CHEST_N': 746,
    'ACT3_TEMPLE_6': 753,
    'ACT3_MEPHISTO_W': 754,
    'ACT3_MEPHISTO_E': 755,
    'ACT3_MEPHISTO_S': 757,
    'ACT3_MEPHISTO_N': 761,
    'ACT3_MEPHISTO_PREV_W': 784,
    'ACT3_MEPHISTO_PREV_E': 785,
    'ACT3_MEPHISTO_PREV_S': 786,
    'ACT3_MEPHISTO_PREV_N': 787,
    'ACT3_MEPHISTO_NEXT_W': 788,
    'ACT3_MEPHISTO_NEXT_E': 789,
    'ACT3_MEPHISTO_NEXT_S': 790,
    'ACT3_MEPHISTO_NEXT_N': 791,
    'ACT3_MEPHISTO_WAYPOINT_W': 792,
    'ACT3_MEPHISTO_WAYPOINT_E': 793,
    'ACT3_MEPHISTO_WAYPOINT_S': 794,
    'ACT3_MEPHISTO_WAYPOINT_N': 795,
    'ACT4_LAVA_X': 836,
    'ACT4_LAVA_W': 837,
    'ACT4_LAVA_E': 838,
    'ACT4_LAVA_WARP_N': 852,
    'ACT4_LAVA_FORGE_W': 853,
    'ACT4_LAVA_FORGE_E': 854,
    'ACT4_BRIDGE_1': 855,
    'ACT4_BRIDGE_2': 856,
    'ACT5_BARRICADE_16_SNOW': 1002,
    'ACT5_ICE_W': 1003,
    'ACT5_ICE_E': 1004,
    'ACT5_ICE_S': 1006,
    'ACT5_ICE_N': 1010,
    'ACT5_ICE_PREV_W': 1018,
    'ACT5_ICE_PREV_E': 1019,
    'ACT5_ICE_PREV_S': 1020,
    'ACT5_ICE_PREV_N': 1021,
    'ACT5_ICE_NEXT_W': 1022,
    'ACT5_ICE_NEXT_E': 1023,
    'ACT5_ICE_NEXT_S': 1024,
    'ACT5_ICE_NEXT_N': 1025,
    'ACT5_ICE_DOWN_W': 1026,
    'ACT5_ICE_DOWN_E': 1027,
    'ACT5_ICE_DOWN_S': 1028,
    'ACT5_ICE_DOWN_N': 1029,
    'ACT5_ICE_THEME_W': 1030,
    'ACT5_ICE_THEME_E': 1031,
    'ACT5_ICE_THEME_S': 1032,
    'ACT5_ICE_THEME_N': 1033,
    'ACT5_ICE_WAYPOINT_N': 1034,
    'ACT5_ICE_WAYPOINT_S': 1035,
    'ACT5_ICE_WAYPOINT_E': 1036,
    'ACT5_ICE_WAYPOINT_W': 1037,
    'ACT5_ICE_RIVER_A': 1038,
    'ACT5_ICE_RIVER_B': 1039,
    'ACT5_ICE_POOL_A': 1040,
    'ACT5_ICE_POOL_B': 1041,
    'ACT5_TEMPLE_NE': 1042,
    'ACT5_TEMPLE_NW': 1043,
    'ACT5_TEMPLE_SE_UP': 1044,
    'ACT5_TEMPLE_SW': 1045,
    'ACT5_TEMPLE_NE_DOWN': 1046,
    'ACT5_TEMPLE_NW_DOWN': 1047,
    'ACT5_TEMPLE_SW_DOWN': 1048,
    'ACT5_TEMPLE_NE_WAYPOINT': 1049,
    'ACT5_TEMPLE_NW_WAYPOINT': 1050,
    'ACT5_TEMPLE_SE_WAYPOINT': 1051,
    'ACT5_TEMPLE_SW_WAYPOINT': 1052,
    'ACT5_LAVA_N': 1053,
    'ACT5_LAVA_S': 1054,
    'ACT5_LAVA_E': 1055,
    'ACT5_LAVA_W': 1056,
    'ACT5_LAVA_EW': 1057,
    'ACT5_LAVA_NS': 1058,
    'ACT5_BAAL_W': 1059,
    'ACT5_BAAL_E': 1060,
    'ACT5_BAAL_S': 1062,
    'ACT5_BAAL_N': 1066,
    'ACT5_BAAL_PREV_NEW': 1074,
    'ACT5_BAAL_PREV_NSE': 1075,
    'ACT5_BAAL_PREV_NSW': 1076,
    'ACT5_BAAL_PREV_SEW': 1077,
    'ACT5_BAAL_NEXT_N': 1078,
    'ACT5_BAAL_NEXT_S': 1079,
    'ACT5_BAAL_NEXT_E': 1080,
    'ACT5_BAAL_NEXT_W': 1081,
    'ACT5_BAAL_WAYPOINT_N': 1082,
    'ACT5_BAAL_WAYPOINT_S': 1083,
    'ACT5_BAAL_WAYPOINT_E': 1084,
    'ACT5_BAAL_WAYPOINT_W': 1085,
}
LVL = {   # D2C_Levels (LevelsIds.h)
    'DENOFEVIL': 8,
    'CAVELEV1': 9,
    'UNDERGROUNDPASSAGELEV1': 10,
    'CRYPT': 18,
    'MAUSOLEUM': 19,
    'TOWERCELLARLEV1': 21,
    'TOWERCELLARLEV4': 24,
    'BARRACKS': 28,
    'JAILLEV1': 29,
    'JAILLEV2': 30,
    'JAILLEV3': 31,
    'CATACOMBSLEV1': 34,
    'CATACOMBSLEV2': 35,
    'SEWERSLEV1': 47,
    'SEWERSLEV2': 48,
    'SEWERSLEV3': 49,
    'PALACECELLARLEV1': 52,
    'STONYTOMBLEV1': 55,
    'HALLSOFTHEDEADLEV2': 57,
    'CLAWVIPERTEMPLELEV1': 58,
    'STONYTOMBLEV2': 59,
    'HALLSOFTHEDEADLEV3': 60,
    'CLAWVIPERTEMPLELEV2': 61,
    'MAGGOTLAIRLEV3': 64,
    'ANCIENTTUNNELS': 65,
    'TALRASHASTOMB1': 66,
    'TALRASHASTOMB7': 72,
    'SPIDERCAVE': 84,
    'SPIDERCAVERN': 85,
    'SEWERSA3LEV1': 92,
    'DURANCEOFHATELEV1': 100,
    'DURANCEOFHATELEV2': 101,
    'CRYSTALIZEDCAVERNLEV1': 113,
    'CELLAROFPITY': 114,
    'CRYSTALIZEDCAVERNLEV2': 115,
    'ECHOCHAMBER': 116,
    'GLACIALCAVESLEV1': 118,
    'GLACIALCAVESLEV2': 119,
    'HALLSOFDEATHSCALLING': 123,
    'HALLSOFVAUGHT': 124,
    'THEWORLDSTONEKEEPLEV2': 129,
    'PANDEMONIUMRUN1': 133,
}
# DrlgMaze.cpp: static const D2MazeLevelIdStrc tables {dead-end preset to replace, special preset, unused, direction to attach a new cell}
TABLES = {
    'nAct1CavePrevIds': [('ACT1_CAVE_N', 'ACT1_CAVE_PREV_N', -1, 3), ('ACT1_CAVE_E', 'ACT1_CAVE_PREV_E', -1, 0), ('ACT1_CAVE_S', 'ACT1_CAVE_PREV_S', -1, 1), ('ACT1_CAVE_W', 'ACT1_CAVE_PREV_W', -1, 2)],
    'nAct1CaveDOEIds': [('ACT1_CAVE_N', 'ACT1_CAVE_DEN_OF_EVIL_N', -1, 3), ('ACT1_CAVE_E', 'ACT1_CAVE_DEN_OF_EVIL_E', -1, 0), ('ACT1_CAVE_S', 'ACT1_CAVE_DEN_OF_EVIL_S', -1, 1), ('ACT1_CAVE_W', 'ACT1_CAVE_DEN_OF_EVIL_W', -1, 2)],
    'nAct1CaveDownIds': [('ACT1_CAVE_N', 'ACT1_CAVE_DOWN_N', -1, 3), ('ACT1_CAVE_E', 'ACT1_CAVE_DOWN_E', -1, 0), ('ACT1_CAVE_S', 'ACT1_CAVE_DOWN_S', -1, 1), ('ACT1_CAVE_W', 'ACT1_CAVE_DOWN_W', -1, 2)],
    'nAct1CaveColdcrowIds': [('ACT1_CAVE_N', 'ACT1_CAVE_COLDCROW_N', -1, 3), ('ACT1_CAVE_E', 'ACT1_CAVE_COLDCROW_E', -1, 0), ('ACT1_CAVE_S', 'ACT1_CAVE_COLDCROW_S', -1, 1), ('ACT1_CAVE_W', 'ACT1_CAVE_COLDCROW_W', -1, 2)],
    'nAct1CaveNextIds': [('ACT1_CAVE_N', 'ACT1_CAVE_NEXT_N', -1, 3), ('ACT1_CAVE_E', 'ACT1_CAVE_NEXT_E', -1, 0), ('ACT1_CAVE_S', 'ACT1_CAVE_NEXT_S', -1, 1), ('ACT1_CAVE_W', 'ACT1_CAVE_NEXT_W', -1, 2)],
    'nAct1CryptPrevIds': [('ACT1_CRYPT_N', 'ACT1_CRYPT_PREV_N', -1, 3), ('ACT1_CRYPT_E', 'ACT1_CRYPT_PREV_E', -1, 0), ('ACT1_CRYPT_S', 'ACT1_CRYPT_PREV_S', -1, 1), ('ACT1_CRYPT_W', 'ACT1_CRYPT_PREV_W', -1, 2)],
    'nAct1CryptSpecialIds': [('ACT1_CRYPT_N', 'ACT1_CRYPT_BONEBREAK_N', -1, 3), ('ACT1_CRYPT_E', 'ACT1_CRYPT_BONEBREAK_E', -1, 0), ('ACT1_CRYPT_S', 'ACT1_CRYPT_BONEBREAK_S', -1, 1), ('ACT1_CRYPT_W', 'ACT1_CRYPT_BONEBREAK_W', -1, 2), ('ACT1_CRYPT_N', 'ACT1_CRYPT_PORTAL_N', -1, 3), ('ACT1_CRYPT_E', 'ACT1_CRYPT_PORTAL_E', -1, 0), ('ACT1_CRYPT_S', 'ACT1_CRYPT_PORTAL_S', -1, 1), ('ACT1_CRYPT_W', 'ACT1_CRYPT_PORTAL_W', -1, 2)],
    'nAct1CryptChestIds': [('ACT1_CRYPT_N', 'ACT1_CRYPT_CHEST_N', -1, 3), ('ACT1_CRYPT_E', 'ACT1_CRYPT_CHEST_E', -1, 0), ('ACT1_CRYPT_S', 'ACT1_CRYPT_CHEST_S', -1, 1), ('ACT1_CRYPT_W', 'ACT1_CRYPT_CHEST_W', -1, 2)],
    'nAct1CryptNextIds': [('ACT1_CRYPT_N', 'ACT1_CRYPT_NEXT_N', -1, 3), ('ACT1_CRYPT_E', 'ACT1_CRYPT_NEXT_E', -1, 0), ('ACT1_CRYPT_S', 'ACT1_CRYPT_NEXT_S', -1, 1), ('ACT1_CRYPT_W', 'ACT1_CRYPT_NEXT_W', -1, 2)],
    'nAct1JailPrevIds': [('ACT1_JAIL_N', 'ACT1_JAIL_PREV_N', -1, 3), ('ACT1_JAIL_E', 'ACT1_JAIL_PREV_E', -1, 0), ('ACT1_JAIL_S', 'ACT1_JAIL_PREV_S', -1, 1), ('ACT1_JAIL_W', 'ACT1_JAIL_PREV_W', -1, 2)],
    'nAct1JailCathIds': [('ACT1_JAIL_N', 'ACT1_JAIL_CATH_N', -1, 3), ('ACT1_JAIL_E', 'ACT1_JAIL_CATH_E', -1, 0), ('ACT1_JAIL_S', 'ACT1_JAIL_CATH_S', -1, 1), ('ACT1_JAIL_W', 'ACT1_JAIL_CATH_W', -1, 2)],
    'nAct1JailNextIds': [('ACT1_JAIL_N', 'ACT1_JAIL_NEXT_N', -1, 3), ('ACT1_JAIL_E', 'ACT1_JAIL_NEXT_E', -1, 0), ('ACT1_JAIL_S', 'ACT1_JAIL_NEXT_S', -1, 1), ('ACT1_JAIL_W', 'ACT1_JAIL_NEXT_W', -1, 2)],
    'nAct1JailWaypointIds': [('ACT1_JAIL_N', 'ACT1_JAIL_WAYPOINT_N', -1, 3), ('ACT1_JAIL_E', 'ACT1_JAIL_WAYPOINT_E', -1, 0), ('ACT1_JAIL_S', 'ACT1_JAIL_WAYPOINT_S', -1, 1), ('ACT1_JAIL_W', 'ACT1_JAIL_WAYPOINT_W', -1, 2)],
    'nAct1JailPitspawnIds': [('ACT1_JAIL_N', 'ACT1_JAIL_PITSPAWN_N', -1, 3), ('ACT1_JAIL_E', 'ACT1_JAIL_PITSPAWN_E', -1, 0), ('ACT1_JAIL_S', 'ACT1_JAIL_PITSPAWN_S', -1, 1), ('ACT1_JAIL_W', 'ACT1_JAIL_PITSPAWN_W', -1, 2)],
    'nAct1CatacombsNextIds': [('ACT1_CATACOMBS_N', 'ACT1_CATACOMBS_NEXT_N', -1, 3), ('ACT1_CATACOMBS_E', 'ACT1_CATACOMBS_NEXT_E', -1, 0), ('ACT1_CATACOMBS_S', 'ACT1_CATACOMBS_NEXT_S', -1, 1), ('ACT1_CATACOMBS_W', 'ACT1_CATACOMBS_NEXT_W', -1, 2)],
    'nAct1CatacombsWaypointIds': [('ACT1_CATACOMBS_N', 'ACT1_CATACOMBS_WAYPOINT_N', -1, 3), ('ACT1_CATACOMBS_E', 'ACT1_CATACOMBS_WAYPOINT_E', -1, 0), ('ACT1_CATACOMBS_S', 'ACT1_CATACOMBS_WAYPOINT_S', -1, 1), ('ACT1_CATACOMBS_W', 'ACT1_CATACOMBS_WAYPOINT_W', -1, 2)],
    'nAct2ArcaneSummonerIds': [('ACT2_ARCANE_N', 'ACT2_ARCANE_SUMMONER_N', -1, 3), ('ACT2_ARCANE_E', 'ACT2_ARCANE_SUMMONER_E', -1, 0), ('ACT2_ARCANE_S', 'ACT2_ARCANE_SUMMONER_S', -1, 1), ('ACT2_ARCANE_W', 'ACT2_ARCANE_SUMMONER_W', -1, 2)],
    'nAct2SewerPrevIds': [('ACT2_SEWER_N', 'ACT2_SEWER_PREV_N', -1, 3), ('ACT2_SEWER_E', 'ACT2_SEWER_PREV_E', -1, 0), ('ACT2_SEWER_S', 'ACT2_SEWER_PREV_S', -1, 1), ('ACT2_SEWER_W', 'ACT2_SEWER_PREV_W', -1, 2)],
    'nAct2SewerNextIds': [('ACT2_SEWER_N', 'ACT2_SEWER_NEXT_N', -1, 3), ('ACT2_SEWER_E', 'ACT2_SEWER_NEXT_E', -1, 0), ('ACT2_SEWER_S', 'ACT2_SEWER_NEXT_S', -1, 1), ('ACT2_SEWER_W', 'ACT2_SEWER_NEXT_W', -1, 2)],
    'nAct2SewerWaypointIds': [('ACT2_SEWER_N', 'ACT2_SEWER_WAYPOINT_N', -1, 3), ('ACT2_SEWER_E', 'ACT2_SEWER_WAYPOINT_E', -1, 0), ('ACT2_SEWER_S', 'ACT2_SEWER_WAYPOINT_S', -1, 1), ('ACT2_SEWER_W', 'ACT2_SEWER_WAYPOINT_W', -1, 2)],
    'nAct2SewerRadamentIds': [('ACT2_SEWER_N', 'ACT2_SEWER_RADAMENTS_LAIR_N', -1, 3), ('ACT2_SEWER_E', 'ACT2_SEWER_RADAMENTS_LAIR_E', -1, 0), ('ACT2_SEWER_S', 'ACT2_SEWER_RADAMENTS_LAIR_S', -1, 1), ('ACT2_SEWER_W', 'ACT2_SEWER_RADAMENTS_LAIR_W', -1, 2)],
    'nAct2SewerChestIds': [('ACT2_SEWER_N', 'ACT2_SEWER_CHEST_N', -1, 3), ('ACT2_SEWER_E', 'ACT2_SEWER_CHEST_E', -1, 0), ('ACT2_SEWER_S', 'ACT2_SEWER_CHEST_S', -1, 1), ('ACT2_SEWER_W', 'ACT2_SEWER_CHEST_W', -1, 2)],
    'nAct2TombNextIds': [('ACT2_TOMB_N', 'ACT2_TOMB_NEXT_N', -1, 3), ('ACT2_TOMB_E', 'ACT2_TOMB_NEXT_E', -1, 0), ('ACT2_TOMB_S', 'ACT2_TOMB_NEXT_S', -1, 1), ('ACT2_TOMB_W', 'ACT2_TOMB_NEXT_W', -1, 2)],
    'nAct2TombWaypointIds': [('ACT2_TOMB_N', 'ACT2_TOMB_WAYPOINT_N', -1, 3), ('ACT2_TOMB_E', 'ACT2_TOMB_WAYPOINT_E', -1, 0), ('ACT2_TOMB_S', 'ACT2_TOMB_WAYPOINT_S', -1, 1), ('ACT2_TOMB_W', 'ACT2_TOMB_WAYPOINT_W', -1, 2)],
    'nAct2TombChestIds': [('ACT2_TOMB_N', 'ACT2_TOMB_CHEST_N', -1, 3), ('ACT2_TOMB_E', 'ACT2_TOMB_CHEST_E', -1, 0), ('ACT2_TOMB_S', 'ACT2_TOMB_CHEST_S', -1, 1), ('ACT2_TOMB_W', 'ACT2_TOMB_CHEST_W', -1, 2)],
    'nAct2TombLeatherarmIds': [('ACT2_TOMB_N', 'ACT2_TOMB_LEATHERARM_N', -1, 3), ('ACT2_TOMB_E', 'ACT2_TOMB_LEATHERARM_E', -1, 0), ('ACT2_TOMB_S', 'ACT2_TOMB_LEATHERARM_S', -1, 1), ('ACT2_TOMB_W', 'ACT2_TOMB_LEATHERARM_W', -1, 2)],
    'nAct2TombCubeIds': [('ACT2_TOMB_N', 'ACT2_TOMB_CUBE_N', -1, 3), ('ACT2_TOMB_E', 'ACT2_TOMB_CUBE_E', -1, 0), ('ACT2_TOMB_S', 'ACT2_TOMB_CUBE_S', -1, 1), ('ACT2_TOMB_W', 'ACT2_TOMB_CUBE_W', -1, 2)],
    'nAct2TombTreasureIds': [('ACT2_TOMB_N', 'ACT2_TOMB_TREASURE_N', -1, 3), ('ACT2_TOMB_E', 'ACT2_TOMB_TREASURE_E', -1, 0), ('ACT2_TOMB_S', 'ACT2_TOMB_TREASURE_S', -1, 1), ('ACT2_TOMB_W', 'ACT2_TOMB_TREASURE_W', -1, 2)],
    'nAct2TombTalRashaIds': [('ACT2_TOMB_N', 'ACT2_TOMB_TALRASHA_N', -1, 3), ('ACT2_TOMB_E', 'ACT2_TOMB_TALRASHA_E', -1, 0), ('ACT2_TOMB_S', 'ACT2_TOMB_TALRASHA_S', -1, 1), ('ACT2_TOMB_W', 'ACT2_TOMB_TALRASHA_W', -1, 2)],
    'nAct2TombKaaIds': [('ACT2_TOMB_N', 'ACT2_TOMB_KAA_N', -1, 3), ('ACT2_TOMB_E', 'ACT2_TOMB_KAA_E', -1, 0), ('ACT2_TOMB_S', 'ACT2_TOMB_KAA_S', -1, 1), ('ACT2_TOMB_W', 'ACT2_TOMB_KAA_W', -1, 2)],
    'nAct2LairPrevIds': [('ACT2_LAIR_N', 'ACT2_LAIR_PREV_N', -1, 3), ('ACT2_LAIR_E', 'ACT2_LAIR_PREV_E', -1, 0), ('ACT2_LAIR_S', 'ACT2_LAIR_PREV_S', -1, 1), ('ACT2_LAIR_W', 'ACT2_LAIR_PREV_W', -1, 2)],
    'nAct2LairSpecialIds': [('ACT2_LAIR_N', 'ACT2_LAIR_NEXT_N', -1, 3), ('ACT2_LAIR_E', 'ACT2_LAIR_NEXT_E', -1, 0), ('ACT2_LAIR_S', 'ACT2_LAIR_NEXT_S', -1, 1), ('ACT2_LAIR_W', 'ACT2_LAIR_NEXT_W', -1, 2), ('ACT2_LAIR_N', 'ACT2_LAIR_TREASURE_N', -1, 3), ('ACT2_LAIR_E', 'ACT2_LAIR_TREASURE_E', -1, 0), ('ACT2_LAIR_S', 'ACT2_LAIR_TREASURE_S', -1, 1), ('ACT2_LAIR_W', 'ACT2_LAIR_TREASURE_W', -1, 2), ('ACT2_LAIR_S', 'ACT2_LAIR_TIGHT_SPOT_S', -1, 1)],
    'nAct3DungeonPrevIds': [('ACT3_DUNGEON_N', 'ACT3_DUNGEON_PREV_N', -1, 3), ('ACT3_DUNGEON_E', 'ACT3_DUNGEON_PREV_E', -1, 0), ('ACT3_DUNGEON_S', 'ACT3_DUNGEON_PREV_S', -1, 1), ('ACT3_DUNGEON_W', 'ACT3_DUNGEON_PREV_W', -1, 2)],
    'nAct3DungeonNextIds': [('ACT3_DUNGEON_N', 'ACT3_DUNGEON_NEXT_N', -1, 3), ('ACT3_DUNGEON_E', 'ACT3_DUNGEON_NEXT_E', -1, 0), ('ACT3_DUNGEON_S', 'ACT3_DUNGEON_NEXT_S', -1, 1), ('ACT3_DUNGEON_W', 'ACT3_DUNGEON_NEXT_W', -1, 2)],
    'nAct3SewerDrainIds': [('ACT3_SEWER_N', 'ACT3_SEWER_DRAIN_N', -1, 3), ('ACT3_SEWER_E', 'ACT3_SEWER_DRAIN_E', -1, 0), ('ACT3_SEWER_S', 'ACT3_SEWER_DRAIN_S', -1, 1), ('ACT3_SEWER_W', 'ACT3_SEWER_DRAIN_W', -1, 2)],
    'nAct3SewerChestIds': [('ACT3_SEWER_N', 'ACT3_SEWER_CHEST_N', -1, 3), ('ACT3_SEWER_E', 'ACT3_SEWER_CHEST_E', -1, 0), ('ACT3_SEWER_S', 'ACT3_SEWER_CHEST_S', -1, 1), ('ACT3_SEWER_W', 'ACT3_SEWER_CHEST_W', -1, 2)],
    'nAct3MephistoPrevIds': [('ACT3_MEPHISTO_N', 'ACT3_MEPHISTO_PREV_N', -1, 3), ('ACT3_MEPHISTO_E', 'ACT3_MEPHISTO_PREV_E', -1, 0), ('ACT3_MEPHISTO_S', 'ACT3_MEPHISTO_PREV_S', -1, 1), ('ACT3_MEPHISTO_W', 'ACT3_MEPHISTO_PREV_W', -1, 2)],
    'nAct3MephistoWaypointIds': [('ACT3_MEPHISTO_N', 'ACT3_MEPHISTO_WAYPOINT_N', -1, 3), ('ACT3_MEPHISTO_E', 'ACT3_MEPHISTO_WAYPOINT_E', -1, 0), ('ACT3_MEPHISTO_S', 'ACT3_MEPHISTO_WAYPOINT_S', -1, 1), ('ACT3_MEPHISTO_W', 'ACT3_MEPHISTO_WAYPOINT_W', -1, 2)],
    'nAct3MephistoNextIds': [('ACT3_MEPHISTO_N', 'ACT3_MEPHISTO_NEXT_N', -1, 3), ('ACT3_MEPHISTO_E', 'ACT3_MEPHISTO_NEXT_E', -1, 0), ('ACT3_MEPHISTO_S', 'ACT3_MEPHISTO_NEXT_S', -1, 1), ('ACT3_MEPHISTO_W', 'ACT3_MEPHISTO_NEXT_W', -1, 2)],
    'nAct5TempleSpecialIds': [('ACT5_TEMPLE_NE', 'ACT5_TEMPLE_NE_DOWN', -1, 1), ('ACT5_TEMPLE_NW', 'ACT5_TEMPLE_NW_DOWN', -1, 0), ('ACT5_TEMPLE_SW', 'ACT5_TEMPLE_SW_DOWN', -1, 3), ('ACT5_TEMPLE_NE', 'ACT5_TEMPLE_NE_WAYPOINT', -1, 1), ('ACT5_TEMPLE_NW', 'ACT5_TEMPLE_NW_WAYPOINT', -1, 0), ('ACT5_TEMPLE_SW', 'ACT5_TEMPLE_SW_WAYPOINT', -1, 3), ('ACT5_TEMPLE_SE_UP', 'ACT5_TEMPLE_SE_WAYPOINT', -1, 2)],
    'nAct5BaalNextIds': [('ACT5_BAAL_N', 'ACT5_BAAL_NEXT_N', -1, 3), ('ACT5_BAAL_E', 'ACT5_BAAL_NEXT_E', -1, 0), ('ACT5_BAAL_S', 'ACT5_BAAL_NEXT_S', -1, 1), ('ACT5_BAAL_W', 'ACT5_BAAL_NEXT_W', -1, 2)],
    'nAct5BaalWaypointIds': [('ACT5_BAAL_N', 'ACT5_BAAL_WAYPOINT_N', -1, 3), ('ACT5_BAAL_E', 'ACT5_BAAL_WAYPOINT_E', -1, 0), ('ACT5_BAAL_S', 'ACT5_BAAL_WAYPOINT_S', -1, 1), ('ACT5_BAAL_W', 'ACT5_BAAL_WAYPOINT_W', -1, 2)],
    'nAct1BarracksNextIds': [('ACT1_BARRACKS_N', 'ACT1_BARRACKS_NEXT_N', -1, 3), ('ACT1_BARRACKS_E', 'ACT1_BARRACKS_NEXT_E', -1, 0), ('ACT1_BARRACKS_S', 'ACT1_BARRACKS_NEXT_S', -1, 1), ('ACT1_BARRACKS_W', 'ACT1_BARRACKS_NEXT_W', -1, 2)],
    'nAct1BarracksForgeIds': [('ACT1_BARRACKS_N', 'ACT1_BARRACKS_FORGE_N', -1, 3), ('ACT1_BARRACKS_E', 'ACT1_BARRACKS_FORGE_E', -1, 0), ('ACT1_BARRACKS_S', 'ACT1_BARRACKS_FORGE_S', -1, 1), ('ACT1_BARRACKS_W', 'ACT1_BARRACKS_FORGE_W', -1, 2)],
    'nAct4LavaForgeIds': [('ACT4_LAVA_W', 'ACT4_LAVA_FORGE_W', -1, 2), ('ACT4_LAVA_E', 'ACT4_LAVA_FORGE_E', -1, 0)],
    'nAct5IcePrevIds': [('ACT5_ICE_N', 'ACT5_ICE_PREV_N', -1, 3), ('ACT5_ICE_E', 'ACT5_ICE_PREV_E', -1, 0), ('ACT5_ICE_S', 'ACT5_ICE_PREV_S', -1, 1), ('ACT5_ICE_W', 'ACT5_ICE_PREV_W', -1, 2)],
    'nAct5IceNextIds': [('ACT5_ICE_N', 'ACT5_ICE_NEXT_N', -1, 3), ('ACT5_ICE_E', 'ACT5_ICE_NEXT_E', -1, 0), ('ACT5_ICE_S', 'ACT5_ICE_NEXT_S', -1, 1), ('ACT5_ICE_W', 'ACT5_ICE_NEXT_W', -1, 2)],
    'nAct5IceDownIds': [('ACT5_ICE_N', 'ACT5_ICE_DOWN_N', -1, 3), ('ACT5_ICE_E', 'ACT5_ICE_DOWN_E', -1, 0), ('ACT5_ICE_S', 'ACT5_ICE_DOWN_S', -1, 1), ('ACT5_ICE_W', 'ACT5_ICE_DOWN_W', -1, 2)],
    'nAct5IceThemeIds': [('ACT5_ICE_N', 'ACT5_ICE_THEME_N', -1, 3), ('ACT5_ICE_E', 'ACT5_ICE_THEME_E', -1, 0), ('ACT5_ICE_S', 'ACT5_ICE_THEME_S', -1, 1), ('ACT5_ICE_W', 'ACT5_ICE_THEME_W', -1, 2)],
    'nAct5IceWaypointIds': [('ACT5_ICE_N', 'ACT5_ICE_WAYPOINT_N', -1, 3), ('ACT5_ICE_E', 'ACT5_ICE_WAYPOINT_E', -1, 0), ('ACT5_ICE_S', 'ACT5_ICE_WAYPOINT_S', -1, 1), ('ACT5_ICE_W', 'ACT5_ICE_WAYPOINT_W', -1, 2)],
}


def _resolve(t):
    return {k: [(PRE[a], PRE[b], c, d) for a, b, c, d in v] for k, v in t.items()}


TABLES = _resolve(TABLES)
PRE = {"LVLPREST_" + k: v for k, v in PRE.items()}
LVL = {"LEVEL_" + k: v for k, v in LVL.items()}


def P(name):
    return PRE["LVLPREST_" + name]


def L(name):
    return LVL["LEVEL_" + name]


PREST_ROWS = []


def row_of(pid):
    """enum value -> lvlprest.txt row (the table has one extra 'Expansion' separator row at 863; verified by name for all 1090 entries but 4 duplicates)"""
    return PREST_ROWS[pid + (1 if pid >= 863 else 0)]


# ---------------------------------------------------------------- geometry
class Room:
    __slots__ = ("x", "y", "w", "h", "orth", "prest", "ds1")

    def __init__(self, w, h):
        self.x = self.y = 0
        self.w, self.h = w, h
        self.orth = []        # [(room, direction)]
        self.prest = 0
        self.ds1 = False      # DRLGPRESETROOMFLAG_HAS_MAP_DS1


def no_overlap(a, b, margin=0):
    """DRLG_GetRectanglesManhattanDistanceAndCheckNotOverlapping: True when the boxes are at least `margin` apart on one axis"""
    dx = a.x - b.w - b.x if a.x >= b.x else b.x - a.w - a.x
    dy = a.y - b.h - b.y if a.y >= b.y else b.y - a.h - a.y
    return dx >= margin or dy >= margin


def dist(a, b):
    dx = a.x - b.w - b.x if a.x >= b.x else b.x - a.w - a.x
    dy = a.y - b.h - b.y if a.y >= b.y else b.y - a.h - a.y
    return dx, dy


def direction_from(c1, c2):
    """DRLG_GetDirectionFromCoordinates (0 SW=west link, 1 NW=north, 2 SE=east, 3 NE=south) or -1"""
    if c1.x <= c2.x:
        if c2.x == c1.x + c1.w:
            return 2
    else:
        if c1.x == c2.x + c2.w:
            return 0
    if c1.y <= c2.y:
        if c2.y == c1.y + c1.h:
            return 3
    else:
        if c1.y == c2.y + c2.h:
            return 1
    return -1


OFFS = {0: (-1, 0), 1: (0, -1), 2: (1, 0), 3: (0, 1), 4: (-1, -1), 5: (1, -1), 6: (1, 1), 7: (-1, 1)}
BIT = {0: 1, 1: 8, 2: 2, 3: 4}      # PickRoomPreset: W=1 N=8 E=2 S=4

# hardcoded remappings (DrlgMaze.cpp nHardcodedPresetsRemapping / nExpansionHardcodedPresetsRemapping), by mask
HAREM = {5: "ACT2_CORRUPT_HAREM_SW", 6: "ACT2_CORRUPT_HAREM_SE", 9: "ACT2_CORRUPT_HAREM_NW", 10: "ACT2_CORRUPT_HAREM_NE"}
BASEMENT = {5: "ACT2_BASEMENT_SW", 6: "ACT2_BASEMENT_SE", 9: "ACT2_BASEMENT_NW", 10: "ACT2_BASEMENT_NE"}
SPIDER = {5: "ACT3_SPIDER_SW", 6: "ACT3_SPIDER_SE", 9: "ACT3_SPIDER_NW", 10: "ACT3_SPIDER_NE"}
TEMPLE = {5: "ACT5_TEMPLE_SW", 6: "ACT5_TEMPLE_SE_UP", 9: "ACT5_TEMPLE_NW", 10: "ACT5_TEMPLE_NE"}
LAVA5 = {1: "ACT5_LAVA_W", 2: "ACT5_LAVA_E", 3: "ACT5_LAVA_EW", 4: "ACT5_LAVA_S", 8: "ACT5_LAVA_N", 12: "ACT5_LAVA_NS"}
BASE = {3: "ACT1_DOE_ENTRANCE", 4: "ACT1_GRAVEYARD", 7: "ACT1_BARRACKS_COURT_CONNECT", 8: "ACT1_BARRACKS_FORGE_N", 10: "ACT1_CATHEDRAL",
        13: "ACT2_TOWN", 17: "ACT2_DESERT_RUINS_ELDER", 18: "ACT2_DURIELS_LAIR", 19: "ACT2_LAIR_TIGHT_SPOT_S", 22: "ACT3_TEMPLE_6",
        24: "ACT3_SPIDER_CHEST_NE", 25: "ACT3_DUNGEON_TREASURE_2", 28: "ACT4_LAVA_X", 33: "ACT5_BARRICADE_16_SNOW", 34: "ACT5_LAVA_NS"}
THEMED = {3, 4, 7, 8, 10, 13, 17, 22, 24, 25}      # level types handled by DRLGMAZE_RollAct_1_2_3_BasicPresets


class Fail(Exception):
    pass


class Level:
    def __init__(self, lid, ltype, rooms, sx, sy, merge, rng, staff=0, boss=0, trace=False):
        self.lid, self.lt, self.rooms_cfg, self.sx, self.sy, self.merge = lid, ltype, rooms, sx, sy, merge
        self.rng, self.staff, self.boss, self.trace = rng, staff, boss, trace
        self.rooms = []          # newest first, like pLevel->pFirstRoomEx
        self.first = None
        self.notes = Counter()   # anomalies (failed placements)
        self.steps = 0

    def log(self, *a):
        if self.trace:
            print("   ", *a)

    # ---- room list / links
    def new_room(self):
        return Room(self.sx, self.sy)

    def add(self, r):
        self.rooms.insert(0, r)

    def free(self, r):
        if r in self.rooms:
            self.rooms.remove(r)
        for o, _ in r.orth:
            o.orth = [(q, d) for q, d in o.orth if q is not r]
        r.orth = []

    def alloc_orths(self, a, b, d):
        if not any(q is b for q, _ in a.orth):
            a.orth.append((b, d))
        if not any(q is a for q, _ in b.orth):
            b.orth.append((a, (d - 2) & 3))

    def clear_of(self, r, ignore):
        for c in self.rooms:
            if c is not r and c is not ignore and not no_overlap(r, c, 0):
                return False
        return True

    def place_at(self, new, parent, d):
        dx, dy = OFFS[d]
        new.x, new.y = parent.x + dx * parent.w, parent.y + dy * parent.h

    def link(self, new, parent, d):
        """DRLGMAZE_LinkMazeRooms"""
        self.place_at(new, parent, d)
        for o, _ in parent.orth:
            if not no_overlap(new, o, 0):
                return False
        return self.clear_of(new, parent)

    # ---- presets
    def pick(self, r, reset=True):
        """DRLGMAZE_PickRoomPreset"""
        mask = 0
        for _, d in r.orth:
            mask |= BIT.get(d, 0)
        lt = self.lt
        if lt == 14:
            name = HAREM.get(mask)
        elif lt == 15:
            name = BASEMENT.get(mask)
        elif lt == 23:
            name = SPIDER.get(mask)
        elif lt == 32:
            name = TEMPLE.get(mask)
        elif lt == 35:
            name = LAVA5.get(mask)
        else:
            name = None
        if lt in (14, 15, 23, 32, 35):
            pid = P(name) if name else 0
            if lt == 15 and self.lid == L("PALACECELLARLEV1") and pid == P("ACT2_BASEMENT_NW"):
                pass
        else:
            pid = P(BASE[lt]) + mask
            if lt == 33 and self.rooms_cfg == 1:
                pid = mask
        if lt == 23:
            if self.lid == L("SPIDERCAVE") and pid == P("ACT3_SPIDER_NE"):
                pid = P("ACT3_SPIDER_CHEST_NE")
            if self.lid == L("SPIDERCAVERN") and pid == P("ACT3_SPIDER_NW"):
                pid = P("ACT3_SPIDER_CHEST_NW")
        if pid:
            r.prest = pid
            r.ds1 = not reset

    def set_special(self, r, pid):
        r.prest = pid
        r.ds1 = True

    # ---- adding cells
    def merge_rooms(self, new):
        """DRLGMAZE_MergeMazeRooms (and the identical block of AddAdjacentMazeRoom)"""
        if new.ds1:
            return
        for i in list(self.rooms):
            if i is not new and not i.ds1:
                nx, ny = dist(new, i)
                if nx <= 0 and ny <= 0 and nx != ny:        # !(GetRectangles...(margin 1)) and nX != nY
                    if not any(q is i for q, _ in new.orth):
                        if self.rng.randrange(1000) < self.merge:
                            d = direction_from(i, new)
                            if d != -1:
                                self.alloc_orths(i, new, d)
                                self.pick(i)

    def add_adjacent(self, parent, d, merge=True):
        """DRLGMAZE_AddAdjacentMazeRoom (also the body of the BuildBasicMaze loop)"""
        new = self.new_room()
        self.place_at(new, parent, d)
        for o, _ in parent.orth:
            if not no_overlap(new, o, 0):
                return None
        if not self.clear_of(new, parent):
            return None
        self.alloc_orths(parent, new, d)
        if merge and not parent.ds1:
            self.merge_rooms(new)
        self.add(new)
        if merge:
            self.pick(parent)
        self.pick(new)
        self.log("add cell dir", d, "at", (new.x // self.sx, new.y // self.sy), "-> %d cells" % len(self.rooms))
        return new

    def place_adjacent(self, parent, d, merge):
        """DRLGMAZE_PlaceAdjacentPresetRoom"""
        new = self.new_room()
        self.place_at(new, parent, d)
        for o, _ in parent.orth:
            if not no_overlap(new, o, 0):
                return None
        if not self.clear_of(new, parent):
            return None
        self.alloc_orths(parent, new, d)
        if merge:
            self.merge_rooms(new)
        self.add(new)
        return new

    def may_place(self, r, d):
        """DRLGMAZE_CheckIfMayPlaceAdjacentPresetRoom (pure test; the temporary cell is freed again)"""
        if r.ds1:
            return False
        if any(dd == d for _, dd in r.orth):
            return False
        n = self.place_adjacent(r, d, False)
        if n is None:
            return False
        self.free(n)
        return True

    def target(self):
        n = self.rooms_cfg
        if self.lid == self.staff:
            n *= 3
        elif self.lid == self.boss:
            n *= 2
        return n

    def fill_loop(self, n):
        """while (nRooms < n) { random cell; dir = rand & 3; if !ds1 AddAdjacentMazeRoom(cell, dir, 1) }  (BuildBasicMaze: same without the cap on ds1 parents)"""
        guard = 0
        while len(self.rooms) < n:
            guard += 1
            if guard > 200000:
                self.notes["fill_loop_stuck"] += 1
                break
            r = self.rooms[self.rng.randrange(len(self.rooms))]
            d = self.rng.randrange(4)
            if not r.ds1:
                if self.add_adjacent(r, d, True) is None:
                    self.notes["add_failed"] += 1
            else:
                self.notes["ds1_parent_skipped"] += 1

    def build_basic_maze(self):
        n = self.rooms_cfg
        if self.lid == self.staff:
            n *= 3
        if self.lid == self.boss:
            n *= 2
        self.fill_loop(n)

    def init_basic(self, n):
        """DRLGMAZE_InitBasicMazeLayout: a ring of 4*(n-1) cells around the start cell: N x(n-1), W x(n-1), S x(n-1), E x(n-2), then closing link"""
        first = self.first
        cur = first
        for count, d in ((n - 1, 1), (n - 1, 0), (n - 1, 3), (n - 2, 2)):
            for _ in range(count):
                new = self.new_room()
                if self.link(new, cur, d):
                    self.alloc_orths(cur, new, d)
                    self.merge_rooms(new)
                    self.add(new)
                    self.pick(cur)
                    self.pick(new)
                    nxt = new
                else:
                    self.notes["init_link_failed"] += 1
                    raise Fail("ring")
                cur = nxt
        self.alloc_orths(cur, first, 2)
        self.pick(cur)
        self.pick(first)

    # ---- special presets
    def fixed_preset(self, parent, d, pid):
        """DRLGMAZE_InitRoomFixedPreset(parent, d, pid, bUseInitPreset=1)"""
        new = self.new_room()
        if self.link(new, parent, d):
            self.alloc_orths(parent, new, d)
            self.add(new)
            self.pick(parent)
            self.set_special(new, pid)
            return new
        return None

    def special(self, entry):
        """ReplaceRoomPreset(id1 -> id2) else AddSpecialPreset / the manual loops: replace the first free cell of preset id1, else attach a new cell on side `dir`
        of the first free cell that has room there.  Returns 'replace' / 'add' / None."""
        id1, id2, _, d = entry
        for r in self.rooms:
            if not r.ds1 and r.prest == id1:
                self.set_special(r, id2)
                self.log("special", row_of(id2)["Name"], "replaces a dead end ->", len(self.rooms), "cells")
                return "replace"
        for r in self.rooms:
            if not r.ds1:
                if self.fixed_preset(r, d, id2) is not None:
                    self.log("special", row_of(id2)["Name"], "added as a new cell ->", len(self.rooms), "cells")
                    return "add"
        self.notes["special_not_placed"] += 1
        return None

    def scan(self, entry, rand):
        """DRLGMAZE_ScanReplaceSpecialPreset: same as special(), then *pRand = (*pRand + 1) % 4"""
        self.special(entry)
        return (rand + 1) % 4

    def roll_basic(self):
        """DRLGMAZE_RollAct_1_2_3_BasicPresets"""
        if self.lt not in THEMED or self.lid == L("DENOFEVIL"):
            return
        base = P(BASE[self.lt])
        offs = list(range(15))
        idx = self.rng.randrange(15)
        for _ in range(15):
            a, b = self.rng.randrange(15), self.rng.randrange(15)
            offs[a], offs[b] = offs[b], offs[a]
        c1 = max(2, len(self.rooms) // 5 + 1)
        c2 = 2 * len(self.rooms)
        while c1 and c2:
            pid = offs[idx] + base
            for r in self.rooms:
                if not r.ds1 and r.prest == pid:
                    r.prest = pid + 15
                    r.ds1 = True
                    c1 -= 1
                    break
            c2 -= 1
            idx = (idx + 1) % 15

    # ---- level types
    def generate(self):
        r0 = self.new_room()
        self.first = r0
        self.add(r0)
        lt, lid, rng, T = self.lt, self.lid, self.rng, TABLES
        n = self.target()
        if lt == 3:                                   # Act 1 caves (Den, Cave, Underground Passage, Hole, Pit)
            self.fill_loop(n)
            rand = rng.randrange(4)
            rand = self.scan(T["nAct1CavePrevIds"][rand], rand)
            rand = self.scan((T["nAct1CaveDOEIds"] if lid == L("DENOFEVIL") else T["nAct1CaveDownIds"])[rand], rand)
            if lid == L("CAVELEV1"):
                rand = self.scan(T["nAct1CaveColdcrowIds"][rand], rand)
            if lid == L("UNDERGROUNDPASSAGELEV1"):
                rand = self.scan(T["nAct1CaveNextIds"][rand], rand)
        elif lt == 4:                                 # crypts, mausoleum, tower cellar, pandemonium run 1
            self.fill_loop(n)
            rand = rng.randrange(4)
            rand = self.scan(T["nAct1CryptPrevIds"][rand], rand)
            if lid == L("CRYPT"):
                rand = self.scan(T["nAct1CryptSpecialIds"][rand], rand)
            if lid in (L("MAUSOLEUM"), L("PANDEMONIUMRUN1")):
                rand = self.scan(T["nAct1CryptChestIds"][rand], rand)
            if L("TOWERCELLARLEV1") <= lid <= L("TOWERCELLARLEV4"):
                rand = self.scan(T["nAct1CryptNextIds"][rand], rand)
        elif lt == 7:                                 # Barracks
            self.init_basic(2)
            self.fill_loop(n)
        elif lt == 8:                                 # Jail
            self.init_basic(2)
            self.fill_loop(n)
            rand = rng.randrange(4)
            rand = self.scan(T["nAct1JailPrevIds"][rand], rand)
            if lid == L("JAILLEV1"):
                rand = self.scan(T["nAct1JailWaypointIds"][rand], rand)
            if lid == L("JAILLEV2"):
                rand = self.scan(T["nAct1JailPitspawnIds"][rand], rand)
            if lid == L("JAILLEV3"):
                rand = self.scan(T["nAct1JailCathIds"][rand], rand)
            else:
                rand = self.scan(T["nAct1JailNextIds"][rand], rand)
        elif lt == 10:                                # Catacombs
            f = self.first
            if lid == L("CATACOMBSLEV1"):
                for d in (1, 2, 3, 0):
                    self.add_adjacent(f, d, True)
                self.set_special(f, P("ACT1_CATACOMBS_PREV_NSEW"))
            elif rng.randrange(2):
                self.add_adjacent(f, 0, True)
                self.add_adjacent(f, 2, True)
                self.set_special(f, P("ACT1_CATACOMBS_PREV_EW"))
            else:
                self.add_adjacent(f, 1, True)
                self.add_adjacent(f, 3, True)
                self.set_special(f, P("ACT1_CATACOMBS_PREV_NS"))
            self.fill_loop(n)
            rand = rng.randrange(4)
            rand = self.scan(T["nAct1CatacombsNextIds"][rand], rand)
            if lid == L("CATACOMBSLEV2"):
                rand = self.scan(T["nAct1CatacombsWaypointIds"][rand], rand)
        elif lt == 13:                                # Act 2 sewers, Ancient Tunnels
            self.init_basic(2)
            self.fill_loop(n)
            self.sewers_special()
        elif lt == 17:                                # tombs
            if lid == L("CLAWVIPERTEMPLELEV2"):
                self.set_special(r0, P("ACT2_TOMB_TAINTED_SUN_X"))
            else:
                self.tomb_prev("ACT2")
                self.build_basic_maze()
                self.tomb_stuff()
        elif lt == 18:                                # Maggot lair
            self.init_basic(2)
            self.build_basic_maze()
            self.lair_stuff()
        elif lt == 19:                                # Arcane sanctuary
            self.arcane()
            rand = rng.randrange(4)
            rand = self.scan(T["nAct2ArcaneSummonerIds"][rand], rand)
        elif lt in (14, 15, 23):                      # harem, palace cellar, spider cave
            self.init_basic(2)
        elif lt == 22:                                # Durance of Hate
            self.init_basic(2)
            self.build_basic_maze()
            self.mephisto_stuff()
        elif lt == 24:                                # flayer dungeon
            self.init_basic(2)
            self.build_basic_maze()
            nd = rng.randrange(4)
            self.special(T["nAct3DungeonPrevIds"][nd])
            self.special(T["nAct3DungeonNextIds"][(nd + 1) % 4])
        elif lt == 25:                                # Act 3 sewers
            if lid == L("SEWERSA3LEV1"):
                self.init_basic(5)
                for a, b in (("ACT3_SEWER_SW", "ACT3_SEWER_PREV_SW"), ("ACT3_SEWER_SE", "ACT3_SEWER_PREV_SE"),
                             ("ACT3_SEWER_NW", "ACT3_SEWER_PREV_NW"), ("ACT3_SEWER_NE", "ACT3_SEWER_PREV_NE")):
                    for r in self.rooms:
                        if not r.ds1 and r.prest == P(a):
                            self.set_special(r, P(b))
                            break
            else:
                self.init_basic(2)
            self.build_basic_maze()
            nd = rng.randrange(4)
            self.special(T["nAct3SewerDrainIds"][nd])
            self.special(T["nAct3SewerChestIds"][(nd + 1) % 4])
        elif lt == 28:                                # River of Flame
            self.build_basic_maze()
            self.act4_lava()
        elif lt == 33:                                # ice caves
            if lid in (L("CELLAROFPITY"), L("ECHOCHAMBER"), L("GLACIALCAVESLEV2")):
                nm = {L("CELLAROFPITY"): "ACT5_ICE_RIVER_A" if rng.randrange(2) else "ACT5_ICE_RIVER_B",
                      L("ECHOCHAMBER"): "ACT5_ICE_POOL_A", L("GLACIALCAVESLEV2"): "ACT5_ICE_POOL_B"}[lid]
                self.set_special(r0, P(nm))
            else:
                self.init_basic(2)
                self.build_basic_maze()
                self.ice_stuff()
        elif lt == 32:                                # Nihlathak's temple halls
            self.init_basic(2)
            self.temple_stuff()
        elif lt == 34:                                # Worldstone Keep
            self.tomb_prev("ACT5")
            self.build_basic_maze()
            nd = rng.randrange(4)
            self.special(T["nAct5BaalNextIds"][nd])
            if lid == L("THEWORLDSTONEKEEPLEV2"):
                self.special(T["nAct5BaalWaypointIds"][(nd + 1) % 4])
        elif lt == 35:                                # Hell 1-3, Pandemonium 3 (lava)
            self.lava5()
        else:
            raise Fail("level type %d" % lt)
        if lid == L("BARRACKS"):
            self.barracks()
        self.roll_basic()

    # Act 2 tomb / Act 5 baal: DRLGMAZE_PlaceAct2TombPrev_Act5BaalPrev
    def tomb_prev(self, act):
        names = [("ACT2_TOMB_PREV_NSE", "ACT5_BAAL_PREV_NSE"), ("ACT2_TOMB_PREV_SEW", "ACT5_BAAL_PREV_SEW"),
                 ("ACT2_TOMB_PREV_NSW", "ACT5_BAAL_PREV_NSW"), ("ACT2_TOMB_PREV_NEW", "ACT5_BAAL_PREV_NEW")]
        f = self.first
        d = self.rng.randrange(4)
        for _ in range(3):
            new = self.new_room()
            if self.link(new, f, d):
                self.alloc_orths(f, new, d)
                self.merge_rooms(new)
                self.add(new)
                self.pick(f)
                self.pick(new)
            else:
                self.notes["tomb_prev_link_failed"] += 1
            d = (d + 1) % 4
        self.set_special(f, P(names[d][0 if act == "ACT2" else 1]))

    def tomb_stuff(self):
        T, lid = TABLES, self.lid
        f = self.first
        idx = {P("ACT2_TOMB_PREV_NSW"): 0, P("ACT2_TOMB_PREV_NEW"): 1, P("ACT2_TOMB_PREV_NSE"): 2, P("ACT2_TOMB_PREV_SEW"): 3}[f.prest]
        nd = idx
        if L("STONYTOMBLEV1") <= lid <= L("CLAWVIPERTEMPLELEV1"):
            self.special(T["nAct2TombNextIds"][nd])
            nd = (nd + 1) % 4
        if lid == L("HALLSOFTHEDEADLEV2"):
            self.special(T["nAct2TombWaypointIds"][nd])
            nd = (nd + 1) % 4
        if lid in (L("STONYTOMBLEV2"), L("CLAWVIPERTEMPLELEV2")):
            self.special(T["nAct2TombChestIds"][nd])
            nd = (nd + 1) % 4
        if L("TALRASHASTOMB1") <= lid <= L("TALRASHASTOMB7") and lid != self.staff:
            self.special(T["nAct2TombChestIds"][nd])
            nd = (nd + 1) % 4
        if lid == L("STONYTOMBLEV2"):
            self.special(T["nAct2TombLeatherarmIds"][nd])
            nd = (nd + 1) % 4
        if lid == L("HALLSOFTHEDEADLEV3"):
            self.special(T["nAct2TombCubeIds"][nd])
            nd = (nd + 1) % 4
        if lid in (L("STONYTOMBLEV2"), L("CLAWVIPERTEMPLELEV2")):
            self.special(T["nAct2TombTreasureIds"][nd])
            nd = (nd + 1) % 4
        if lid == self.staff:
            self.special(T["nAct2TombTalRashaIds"][nd])
            nd = (nd + 1) % 4
        if lid == self.boss:
            nd = self.scan(T["nAct2TombKaaIds"][nd], nd)

    def sewers_special(self):
        """DRLGMAZE_ScanReplaceSpecialAct2SewersPresets"""
        T, lid, rng = TABLES, self.lid, self.rng
        d_ns = (2 * rng.randrange(2)) | 1
        rand = rng.randrange(4)
        if lid == L("SEWERSLEV1"):
            r1 = None
            for i in self.rooms:
                if (r1 is None or i.y < r1.y) and self.may_place(i, 1):
                    r1 = i
            r2 = self.place_adjacent(r1, 1, True) if r1 else None
            if r2:
                self.pick(r1)
                self.pick(r2)
            r3 = self.place_adjacent(r2, 1, True) if r2 else None
            if r3:
                self.pick(r2)
                self.pick(r3)
            r4 = self.place_adjacent(r3, 0, False) if r3 else None
            if r4:
                self.pick(r3)
                self.set_special(r4, P("ACT2_SEWER_PREV_E"))
            r1 = None
            for i in self.rooms:
                if (r1 is None or i.x > r1.x) and self.may_place(i, 2):
                    r1 = i
            r2 = self.place_adjacent(r1, 2, True) if r1 else None
            if r2:
                self.pick(r1)
                self.pick(r2)
            r3 = self.place_adjacent(r2, 2, True) if r2 else None
            if r3:
                self.pick(r2)
                self.pick(r3)
            r4 = self.place_adjacent(r3, d_ns, False) if r3 else None
            if r4:
                self.pick(r3)
                self.set_special(r4, P("ACT2_SEWER_PREV_NS"))
            r5 = self.place_adjacent(r4, d_ns, False) if r4 else None
            if r5:
                self.pick(r5)
            self.special(T["nAct2SewerNextIds"][rand])
        elif lid == L("SEWERSLEV2"):
            self.special(T["nAct2SewerPrevIds"][rand])
            rand = (rand + 1) % 4
            rand = self.scan(T["nAct2SewerWaypointIds"][rand], rand)
            rand = self.scan(T["nAct2SewerNextIds"][rand], rand)
        elif lid == L("SEWERSLEV3"):
            rand = self.scan(T["nAct2SewerPrevIds"][rand], rand)
            rand = self.scan(T["nAct2SewerRadamentIds"][rand], rand)
        elif lid == L("ANCIENTTUNNELS"):
            rand = self.scan(T["nAct2SewerPrevIds"][rand], rand)
            rand = self.scan(T["nAct2SewerChestIds"][rand], rand)

    def lair_stuff(self):
        T, lid, rng = TABLES, self.lid, self.rng
        rand = rng.randrange(4)
        if lid == L("MAGGOTLAIRLEV3"):
            done = False
            for r in self.rooms:
                if not r.ds1 and r.prest == P("ACT2_LAIR_S"):
                    self.set_special(r, P("ACT2_LAIR_TIGHT_SPOT_S"))
                    done = True
                    break
            if not done:
                for r in self.rooms:
                    if not r.ds1 and self.fixed_preset(r, 1, P("ACT2_LAIR_TIGHT_SPOT_S")) is not None:
                        break
            self.special((P("ACT2_LAIR_W"), P("ACT2_LAIR_TREASURE_W"), -1, 2))
            idx = 0
        else:
            self.special(T["nAct2LairSpecialIds"][rand])
            idx = (rand + 1) % 4
        self.special(T["nAct2LairPrevIds"][idx])

    def mephisto_stuff(self):
        T, lid = TABLES, self.lid
        rand = self.rng.randrange(4)
        self.special(T["nAct3MephistoPrevIds"][rand])
        v9 = (rand + 1) % 4
        if lid == L("DURANCEOFHATELEV2"):
            self.special(T["nAct3MephistoWaypointIds"][v9])
            v14 = (v9 + 1) % 4
            self.special(T["nAct3MephistoNextIds"][v14])
            v9 = (v14 + 1) % 4
        if lid == L("DURANCEOFHATELEV1"):
            self.special(T["nAct3MephistoNextIds"][v9])

    def ice_stuff(self):
        T, lid = TABLES, self.lid
        nd = self.rng.randrange(4)
        self.special(T["nAct5IcePrevIds"][nd])
        nd = (nd + 1) % 4
        self.special(T["nAct5IceNextIds"][nd])
        nd = (nd + 1) % 4
        self.special(T["nAct5IceDownIds"][nd])
        nd = (nd + 1) % 4
        if lid != L("CRYSTALIZEDCAVERNLEV1"):
            if lid == L("CRYSTALIZEDCAVERNLEV2"):
                self.special(T["nAct5IceThemeIds"][nd])
                nd = (nd + 1) % 4
            elif lid != L("GLACIALCAVESLEV1"):
                return
        self.special(T["nAct5IceWaypointIds"][nd])

    def temple_stuff(self):
        T, lid = TABLES["nAct5TempleSpecialIds"], self.lid
        nd = self.rng.randrange(3)
        start = nd
        if lid != L("HALLSOFVAUGHT"):
            self.special(T[nd])
            nd = (nd + 1) % 4
        if lid == L("HALLSOFDEATHSCALLING"):
            assert nd != start
            self.special(T[nd + 3])

    def barracks(self):
        """DRLGMAZE_PlaceAct1Barracks: the court-connect cell on the side of the Outer Cloister, then Next / Forge presets"""
        T, rng = TABLES, self.rng
        nd = rng.randrange(3)       # Outer Cloister preset direction (DrlgOutPlace.cpp: 3 possible values)
        if nd == 0:       # rightmost cell, east
            p = None
            for i in self.rooms:
                if (p is None or i.x > p.x) and self.may_place(i, 2):
                    p = i
            new = self.new_room()
            if p and self.link(new, p, 2):
                self.alloc_orths(p, new, 2)
                self.add(new)
                self.pick(p)
                self.set_special(new, P("ACT1_BARRACKS_COURT_CONNECT"))
        elif nd == 1:     # lowest cell, south
            p = None
            for i in self.rooms:
                if (p is None or i.y > p.y) and self.may_place(i, 3):
                    p = i
            new = self.new_room()
            if p and self.link(new, p, 3):
                self.alloc_orths(p, new, 3)
                self.add(new)
                self.pick(p)
                self.set_special(new, P("ACT1_BARRACKS_COURT_CONNECT"))
        else:             # leftmost cell, west
            p = None
            for i in self.rooms:
                if (p is None or i.x < p.x) and self.may_place(i, 0):
                    p = i
            new = self.place_adjacent(p, 0, False) if p else None
            if new:
                self.pick(p)
                self.set_special(new, P("ACT1_BARRACKS_COURT_CONNECT"))
        if rng.randrange(2):
            self.special(T["nAct1BarracksNextIds"][nd])
            self.special(T["nAct1BarracksForgeIds"][(nd + 1) % 4])
        else:
            self.special(T["nAct1BarracksForgeIds"][nd])
            nr = (nd + 1) % 4
            self.scan(T["nAct1BarracksNextIds"][nr], nr)

    def act4_lava(self):
        """River of Flame: DRLGMAZE_PlaceAct4Lava + FillBlankMazeSpaces"""
        T = TABLES
        p = None
        for i in self.rooms:
            if (p is None or i.y > p.y) and self.may_place(i, 3):
                p = i
        new = self.new_room()
        if p and self.link(new, p, 3):
            self.alloc_orths(p, new, 3)
            self.add(new)
            self.pick(p)
            self.set_special(new, P("ACT4_LAVA_WARP_N"))
        p = None
        for i in self.rooms:
            if (p is None or i.y < p.y) and self.may_place(i, 1):
                p = i
        b1 = self.place_adjacent(p, 1, False) if p else None
        if b1:
            self.pick(p)
            self.set_special(b1, P("ACT4_BRIDGE_1"))
        b2 = self.place_adjacent(b1, 1, False) if b1 else None
        if b2:
            self.set_special(b2, P("ACT4_BRIDGE_2"))
        b3 = self.place_adjacent(b2, 1, False) if b2 else None
        if b3:
            self.set_special(b3, P("ACT4_BRIDGE_2"))
        self.special(T["nAct4LavaForgeIds"][self.rng.randrange(2)])
        self.fill_blank(P("ACT4_LAVA_X"), b3)

    def fill_blank(self, pid, ignore):
        """DRLGMAZE_FillBlankMazeSpaces: up to 8 neighbours (incl. diagonals) of every cell that existed before the call"""
        for cur in list(self.rooms):
            if cur is ignore:
                continue
            for j in range(8):
                new = self.new_room()
                if self.link(new, cur, j):
                    self.alloc_orths(cur, new, j)
                    self.add(new)
                    self.set_special(new, pid)

    def lava5(self):
        """DRLGMAZE_PlaceAct5LavaPresets: first cell + two lava presets in a line, then everything around is Lava X"""
        sets = [("ACT5_LAVA_S", 1), ("ACT5_LAVA_N", 3), ("ACT5_LAVA_S", 1), ("ACT5_LAVA_N", 3),
                ("ACT5_LAVA_E", 0), ("ACT5_LAVA_W", 2), ("ACT5_LAVA_E", 0), ("ACT5_LAVA_W", 2)]
        nset = 2 * self.rng.randrange(4)
        f = self.first
        for s in (nset, nset + 1):
            name, d = sets[s]
            new = self.new_room()
            if self.link(new, f, d):
                self.alloc_orths(f, new, d)
                self.add(new)
                self.pick(f)
                self.set_special(new, P(name))
        self.fill_blank(P("ACT4_LAVA_X"), None)

    def arcane(self):
        """DRLGMAZE_PlaceArcaneSanctuary: 4 branches of up to 15 cells around the start cell"""
        f = self.first
        self.rng.randrange(4)

        def dir_of(branch, idx):
            if idx in (2, 12):
                return branch + 3
            if idx in (7, 9):
                return branch + 1
            if idx in (10, 11, 13, 14):
                return branch + 2
            return branch
        for br in range(4):
            parent = f
            for idx in range(15):
                d = dir_of(br, idx) % 4
                new = self.place_adjacent(parent, d, True)
                if new:
                    self.pick(parent)
                    self.pick(new)
                else:
                    self.notes["arcane_place_failed"] += 1
                    break
                if idx not in (8, 12):
                    parent = new


def classify(lt, pid, lid):
    """ordinary (direction-mask cell / themed variant) or special"""
    if lt in BASE:
        b = P(BASE[lt])
        if lt == 33:
            return b <= pid <= b + 15
        return b <= pid <= b + 30 if lt in THEMED else b <= pid <= b + 15
    return pid in [P(n) for n in {14: HAREM, 15: BASEMENT, 23: SPIDER, 32: TEMPLE, 35: LAVA5}.get(lt, {}).values()]


def run(lid, d, rng, staff=0, boss=0, trace=False):
    L0 = LEVELS[lid]
    mz = MAZE[lid]
    lv = Level(lid, num(L0["LevelType"]), num(mz[["Rooms", "Rooms(N)", "Rooms(H)"][d]]), num(mz["SizeX"]), num(mz["SizeY"]), num(mz["Merge"]), rng,
               staff, boss, trace)
    lv.generate()
    return lv


LEVELS, MAZE, MAZE_LEVELS = {}, {}, []


def load(folder=None):
    """read the input tables (excel folder) into the module globals"""
    global LEVELS, MAZE, MAZE_LEVELS
    PREST_ROWS[:] = table("lvlprest.txt", folder)
    LEVELS = {num(r["Id"], -1): r for r in table("levels.txt", folder) if r.get("Id")}
    MAZE = {num(r["Level"]): r for r in table("lvlmaze.txt", folder) if r.get("Level") and num(r["Level"]) > 0}
    MAZE_LEVELS = sorted(i for i, r in LEVELS.items() if num(r["DrlgType"]) == 1 and i in MAZE)


def input_digest(folder=None):
    """sha256 of everything the simulation reads from the tables (lvlmaze.txt, id / type of the DrlgType 1 levels, lvlprest names; Populate is applied later, per
    game mode, by build.py): a changed table makes maze_cells.json stale (build.py warns, test_engine.py fails)"""
    lv = [(r.get("Id"), r.get("LevelType")) for r in table("levels.txt", folder) if num(r.get("DrlgType")) == 1]
    pr = [r.get("Name") for r in table("lvlprest.txt", folder)]
    mz = [sorted(r.items()) for r in table("lvlmaze.txt", folder)]
    return hashlib.sha256(json.dumps([lv, pr, mz], separators=(",", ":")).encode("utf-8")).hexdigest()


load()
TOMBS = list(range(L("TALRASHASTOMB1"), L("TALRASHASTOMB7") + 1))
FIXED_MAZE = {114, 116, 119, 125, 126, 127}


def model_cells(lid):
    """the calculator's current rule (engine.js areaRolls): Rooms + specials * (1 if Rooms <= 2 else 0.5), specials = max(2, warps + waypoint)"""
    r, mz = LEVELS[lid], MAZE[lid]
    nw = sum(1 for i in range(8) if num(r.get("Vis%d" % i)) > 0)
    wp = 1 if num(r.get("Waypoint"), 255) < 255 else 0
    big = num(mz["SizeX"]) > 24 or num(mz["SizeY"]) > 24
    out = []
    for k in ("Rooms", "Rooms(N)", "Rooms(H)"):
        c = num(mz[k])
        out.append(c + (0 if lid in FIXED_MAZE or big else max(2, nw + wp) * (1 if c <= 2 else 0.5)))
    return out


def mean_sd(v):
    n = len(v)
    m = sum(v) / n
    return m, (sum((x - m) ** 2 for x in v) / n) ** 0.5


def simulate(seeds, only=None):
    out = {}
    for lid in MAZE_LEVELS:
        if only and lid != only:
            continue
        L0, mz = LEVELS[lid], MAZE[lid]
        lt = num(L0["LevelType"])
        res = {"name": L0["Name"], "type": lt, "rooms": [num(mz[k]) for k in ("Rooms", "Rooms(N)", "Rooms(H)")],
               "cells_mean": [], "cells_sd": [], "cells_min": [], "cells_max": [], "populated_mean": [], "populated_sd": [], "kinds_mean": {},
               "ordinary_mean": [], "special_mean": [], "notes": {}, "model_cells": model_cells(lid)}
        kinds = defaultdict(lambda: [0.0, 0.0, 0.0])
        extra = {}
        for d in range(3):
            rng = random.Random(lid * 1000 + d)
            cells, pops, ords, spcs = [], [], [], []
            kc = Counter()
            notes = Counter()
            cases = defaultdict(list)
            for s in range(seeds):
                staff = boss = 0
                case = "-"
                if lid in TOMBS:
                    staff = lid       # the true tomb: this level is the staff tomb (see the module docstring)
                try:
                    lv = run(lid, d, rng, staff, boss)
                except Fail:
                    notes["generation_failed"] += 1
                    continue
                notes.update(lv.notes)
                n = len(lv.rooms)
                cells.append(n)
                cases[case].append(n)
                pop = o = 0
                for r in lv.rooms:
                    row = row_of(r.prest) if r.prest else None
                    nm = row["Name"] if row else "(none)"
                    kc[nm] += 1
                    if row and num(row["Populate"]):
                        pop += 1
                    if classify(lt, r.prest, lid):
                        o += 1
                pops.append(pop)
                ords.append(o)
                spcs.append(n - o)
            m, sd = mean_sd(cells)
            res["cells_mean"].append(round(m, 3))
            res["cells_sd"].append(round(sd, 3))
            res["cells_min"].append(min(cells))
            res["cells_max"].append(max(cells))
            pm, psd = mean_sd(pops)
            res["populated_mean"].append(round(pm, 3))
            res["populated_sd"].append(round(psd, 3))
            res["ordinary_mean"].append(round(sum(ords) / len(ords), 3))
            res["special_mean"].append(round(sum(spcs) / len(spcs), 3))
            for k, v in kc.items():
                kinds[k][d] = round(v / len(cells), 4)
            res["notes"]["d%d" % d] = {k: round(v / len(cells), 4) for k, v in notes.items()}
        res["kinds_mean"] = {k: v for k, v in sorted(kinds.items(), key=lambda kv: -max(kv[1]))}
        out[lid] = res
    return out


def tomb_split(seeds):
    """Tal Rasha's Tomb 1 (66) mean cells by case, DrlgDrlg.cpp: staff tomb and boss tomb are two different random tombs of the seven -> {difficulty: {case: [mean cells, runs]}}"""
    res = {}
    for d in range(3):
        rng = random.Random(66 * 1000 + 500 + d)
        cases = defaultdict(list)
        for _ in range(seeds):
            a, b = rng.sample(range(7), 2)
            staff, boss = TOMBS[0] + a, TOMBS[0] + b
            lv = run(TOMBS[0], d, rng, staff, boss)
            cases["staff" if staff == TOMBS[0] else "boss" if boss == TOMBS[0] else "plain"].append(len(lv.rooms))
        res["d%d" % d] = {c: [round(sum(v) / len(v), 2), len(v)] for c, v in sorted(cases.items())}
    return res


def trace_one(lid, d=0, seed=1):
    print("trace level %d %s difficulty %d seed %d" % (lid, LEVELS[lid]["Name"], d, seed))
    rng = random.Random(seed)
    lv = run(lid, d, rng, trace=True)
    mz = MAZE[lid]
    print("  Rooms=%s cell %sx%s Merge=%s -> final %d cells" % (mz[["Rooms", "Rooms(N)", "Rooms(H)"][d]], mz["SizeX"], mz["SizeY"], mz["Merge"], len(lv.rooms)))
    xs = [r.x // lv.sx for r in lv.rooms]
    ys = [r.y // lv.sy for r in lv.rooms]
    grid = {}
    for r in lv.rooms:
        grid[(r.x // lv.sx, r.y // lv.sy)] = r
    for y in range(min(ys), max(ys) + 1):
        line = ""
        for x in range(min(xs), max(xs) + 1):
            r = grid.get((x, y))
            line += "  .  " if not r else ("%4s%s" % (row_of(r.prest)["Name"].split(" - ")[-1][:4], "*" if r.ds1 else " "))
        print("   ", line)
    c = Counter(row_of(r.prest)["Name"] if r.prest else "(none)" for r in lv.rooms)
    print("  kinds:", dict(c))
    return lv


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--trace" in args:
        i = args.index("--trace")
        trace_one(int(args[i + 1]), int(args[i + 2]) if len(args) > i + 2 else 0, int(args[i + 3]) if len(args) > i + 3 else 1)
        sys.exit(0)
    seeds = int(args[0]) if args else 2000
    only = int(args[1]) if len(args) > 1 else None
    res = simulate(seeds, None if not only else only)
    if not only:
        for t in TOMBS[1:]:      # the seven tombs are one row in the app: copy the staff-tomb result of level 66 (rows and cell size are identical)
            assert {k: v for k, v in MAZE[t].items() if k not in ("Name", "Level")} == {k: v for k, v in MAZE[TOMBS[0]].items() if k not in ("Name", "Level")}
            res[t] = dict(res[TOMBS[0]], name=LEVELS[t]["Name"], copy_of=TOMBS[0])
        res[TOMBS[0]]["tomb_cases"] = tomb_split(seeds)
    path = OUT if not only else OUT.replace(".json", "_%d.json" % only)
    meta = {"seeds": seeds, "seed": "random.Random(level * 1000 + difficulty)", "digest": input_digest(),
            "inputs": "excel/levels.txt (Id, LevelType of the DrlgType 1 levels), excel/lvlmaze.txt, excel/lvlprest.txt (Name)",
            "tombs": "levels 66-72 simulated as the staff tomb (identical)"}
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"meta": meta, "levels": {str(k): v for k, v in res.items()}}, f, indent=1)
    print("wrote", path)
