// Common birds of coastal Maharashtra / peninsular India, incl. look-alikes.
// Used only as a denylist: any of these in model output must be backed by facts.
// ponytail: hand-picked list; swap for the eBird regional checklist (species_code → name) when it's in the db.

/** Group nouns. Mentioning one is OK iff some allowed name ends with it ("egret" ⇐ "Little Egret"). */
export const BIRD_GROUPS = [
  'egret', 'heron', 'pond heron', 'night heron', 'bittern', 'kingfisher', 'bulbul', 'myna', 'mynah', 'drongo',
  'kite', 'eagle', 'harrier', 'falcon', 'kestrel', 'shikra', 'osprey', 'sandpiper', 'plover', 'lapwing', 'tern',
  'gull', 'bee eater', 'sunbird', 'koel', 'crow', 'parakeet', 'barbet', 'woodpecker', 'cormorant', 'darter',
  'stork', 'ibis', 'spoonbill', 'flamingo', 'pelican', 'stilt', 'avocet', 'redshank', 'greenshank', 'godwit',
  'curlew', 'whimbrel', 'stint', 'dove', 'pigeon', 'owl', 'owlet', 'nightjar', 'hoopoe', 'coucal', 'cuckoo',
  'oriole', 'robin', 'magpie robin', 'shrike', 'prinia', 'tailorbird', 'warbler', 'flycatcher', 'wagtail',
  'pipit', 'lark', 'munia', 'weaver', 'sparrow', 'starling', 'babbler', 'treepie', 'minivet', 'iora', 'tit',
  'white eye', 'flowerpecker', 'moorhen', 'coot', 'waterhen', 'swamphen', 'grebe', 'duck', 'teal', 'jacana',
  'roller', 'peafowl', 'peacock', 'francolin', 'quail', 'vulture', 'buzzard', 'hawk', 'sparrowhawk', 'baza',
  'skimmer', 'pratincole', 'thick knee', 'snipe', 'turnstone', 'hornbill', 'malkoha',
  'bushchat', 'thrush', 'swiftlet',
];

export const KNOWN_SPECIES = [
  // egrets & herons
  'Little Egret', 'Great Egret', 'Intermediate Egret', 'Cattle Egret', 'Western Reef Heron', 'Grey Heron',
  'Purple Heron', 'Indian Pond Heron', 'Striated Heron', 'Black-crowned Night Heron', 'Yellow Bittern',
  'Black Bittern', 'Cinnamon Bittern',
  // kingfishers
  'Common Kingfisher', 'White-throated Kingfisher', 'Pied Kingfisher', 'Stork-billed Kingfisher',
  'Black-capped Kingfisher', 'Collared Kingfisher', 'Oriental Dwarf Kingfisher',
  // bulbuls, mynas, drongos, crows
  'Red-vented Bulbul', 'Red-whiskered Bulbul', 'White-browed Bulbul', 'Common Myna', 'Jungle Myna', 'Bank Myna',
  'Brahminy Starling', 'Rosy Starling', 'Black Drongo', 'Ashy Drongo', 'Hair-crested Drongo',
  'White-bellied Drongo', 'Greater Racket-tailed Drongo', 'House Crow', 'Large-billed Crow', 'Rufous Treepie',
  // raptors
  'Black Kite', 'Brahminy Kite', 'Black-winged Kite', 'Shikra', 'Osprey', 'White-bellied Sea Eagle',
  'Crested Serpent Eagle', 'Booted Eagle', 'Western Marsh Harrier', 'Common Kestrel', 'Peregrine Falcon',
  'Oriental Honey Buzzard', 'Spotted Owlet', 'Barn Owl', 'Indian Scops Owl', 'Brown Fish Owl',
  // waders
  'Common Sandpiper', 'Wood Sandpiper', 'Green Sandpiper', 'Marsh Sandpiper', 'Terek Sandpiper',
  'Curlew Sandpiper', 'Broad-billed Sandpiper', 'Common Redshank', 'Common Greenshank', 'Spotted Redshank',
  'Black-tailed Godwit', 'Bar-tailed Godwit', 'Eurasian Curlew', 'Eurasian Whimbrel', 'Little Stint',
  'Temminck\'s Stint', 'Ruddy Turnstone', 'Ruff', 'Dunlin', 'Sanderling', 'Common Snipe',
  'Little Ringed Plover', 'Kentish Plover', 'Lesser Sand Plover', 'Greater Sand Plover', 'Grey Plover',
  'Pacific Golden Plover', 'Red-wattled Lapwing', 'Yellow-wattled Lapwing', 'Black-winged Stilt', 'Pied Avocet',
  'Eurasian Oystercatcher', 'Crab-plover', 'Indian Stone-curlew', 'Great Thick-knee', 'Small Pratincole',
  // terns & gulls
  'Gull-billed Tern', 'Caspian Tern', 'Greater Crested Tern', 'Lesser Crested Tern', 'Sandwich Tern',
  'Common Tern', 'Little Tern', 'Whiskered Tern', 'River Tern', 'Brown-headed Gull', 'Black-headed Gull',
  'Slender-billed Gull', 'Lesser Black-backed Gull', 'Pallas\'s Gull', 'Indian Skimmer',
  // waterbirds
  'Little Cormorant', 'Great Cormorant', 'Indian Cormorant', 'Oriental Darter', 'Painted Stork',
  'Asian Openbill', 'Woolly-necked Stork', 'Black-headed Ibis', 'Glossy Ibis', 'Eurasian Spoonbill',
  'Greater Flamingo', 'Lesser Flamingo', 'Spot-billed Pelican', 'Little Grebe', 'Eurasian Coot',
  'Common Moorhen', 'White-breasted Waterhen', 'Grey-headed Swamphen', 'Bronze-winged Jacana',
  'Pheasant-tailed Jacana', 'Indian Spot-billed Duck', 'Lesser Whistling Duck', 'Garganey', 'Northern Pintail',
  'Northern Shoveler', 'Cotton Pygmy Goose',
  // bee-eaters, sunbirds, others
  'Green Bee-eater', 'Blue-tailed Bee-eater', 'Blue-cheeked Bee-eater', 'Chestnut-headed Bee-eater',
  'Purple Sunbird', 'Purple-rumped Sunbird', 'Loten\'s Sunbird', 'Asian Koel', 'Greater Coucal',
  'Common Hawk-Cuckoo', 'Pied Cuckoo', 'Rose-ringed Parakeet', 'Plum-headed Parakeet', 'Alexandrine Parakeet',
  'Coppersmith Barbet', 'White-cheeked Barbet', 'Black-rumped Flameback', 'Rock Pigeon', 'Spotted Dove',
  'Laughing Dove', 'Eurasian Collared Dove', 'Yellow-footed Green Pigeon', 'Indian Peafowl', 'Eurasian Hoopoe',
  'Indian Roller', 'Indian Golden Oriole', 'Black-hooded Oriole', 'Oriental Magpie-Robin', 'Indian Robin',
  'Long-tailed Shrike', 'Bay-backed Shrike', 'Ashy Prinia', 'Plain Prinia', 'Common Tailorbird',
  'Blyth\'s Reed Warbler', 'Clamorous Reed Warbler', 'Asian Paradise Flycatcher', 'Tickell\'s Blue Flycatcher',
  'White-browed Wagtail', 'Western Yellow Wagtail', 'Grey Wagtail', 'Paddyfield Pipit', 'Scaly-breasted Munia',
  'Tricolored Munia', 'Baya Weaver', 'House Sparrow', 'Jungle Babbler', 'Yellow-billed Babbler',
  'Small Minivet', 'Common Iora', 'Cinereous Tit', 'Indian White-eye', 'Pale-billed Flowerpecker',
  'Barn Swallow', 'Wire-tailed Swallow', 'Red-rumped Swallow', 'Little Swift', 'Asian Palm Swift',
  'Indian Grey Hornbill', 'Malabar Pied Hornbill', 'Pied Bushchat', 'Indian Nightjar', 'Grey Francolin',
];
