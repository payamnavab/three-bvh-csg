import { BufferAttribute } from 'three';
import { TriangleSplitter } from './TriangleSplitter.js';
import { TypedAttributeData } from './TypedAttributeData.js';
import { OperationDebugData } from './debug/OperationDebugData.js';
import { performOperation } from './operations/operations.js';
import { Brush } from './Brush.js';

// initialize the target geometry and attribute data to be based on
// the given reference geometry
function prepareAttributesData( referenceGeometry, targetGeometry, attributeData, relevantAttributes ) {

	// initialize and clear unused data from the attribute buffers and vice versa
	const aAttributes = referenceGeometry.attributes;
	for ( let i = 0, l = relevantAttributes.length; i < l; i ++ ) {

		const key = relevantAttributes[ i ];
		const aAttr = aAttributes[ key ];
		attributeData.initializeArray( key, aAttr.array.constructor, aAttr.itemSize, aAttr.normalized );

	}

	for ( const key in attributeData.attributes ) {

		if ( ! relevantAttributes.includes( key ) ) {

			attributeData.delete( key );

		}

	}

	for ( const key in targetGeometry.attributes ) {

		if ( ! relevantAttributes.includes( key ) ) {

			targetGeometry.deleteAttribute( key );
			targetGeometry.dispose();

		}

	}

	attributeData.clear();

}

// Assigns the given tracked attribute data to the geometry and returns whether the
// geometry needs to be disposed of.
function assignBufferData( geometry, attributeData, groupOrder ) {

	let needsDisposal = false;
	let drawRange = - 1;

	// set the data
	const attributes = geometry.attributes;
	const referenceAttrSet = attributeData.groupAttributes[ 0 ];
	for ( const key in referenceAttrSet ) {

		const requiredLength = attributeData.getTotalLength( key );
		const type = attributeData.getType( key );
		const itemSize = attributeData.getItemSize( key );
		const normalized = attributeData.getNormalized( key );
		let geoAttr = attributes[ key ];
		if ( ! geoAttr || geoAttr.array.length < requiredLength ) {

			// create the attribute if it doesn't exist yet
			geoAttr = new BufferAttribute( new type( requiredLength ), itemSize, normalized );
			geometry.setAttribute( key, geoAttr );
			needsDisposal = true;

		}

		// assign the data to the geometry attribute buffers in the provided order
		// of the groups list
		let offset = 0;
		for ( let i = 0, l = groupOrder.length; i < l; i ++ ) {

			const index = groupOrder[ i ].index;
			const { array, type, length } = attributeData.groupAttributes[ index ][ key ];
			const trimmedArray = new type( array.buffer, 0, length );
			geoAttr.array.set( trimmedArray, offset );
			offset += trimmedArray.length;

		}

		geoAttr.needsUpdate = true;
		drawRange = requiredLength / geoAttr.itemSize;

	}

	// remove or update the index appropriately
	if ( geometry.index ) {

		const indexArray = geometry.index.array;
		if ( indexArray.length < drawRange ) {

			geometry.index = null;
			needsDisposal = true;

		} else {

			for ( let i = 0, l = indexArray.length; i < l; i ++ ) {

				indexArray[ i ] = i;

			}

		}

	}

	// initialize the groups
	let groupOffset = 0;
	geometry.clearGroups();
	for ( let i = 0, l = attributeData.groupCount; i < l; i ++ ) {

		const vertCount = attributeData.getCount( i );
		if ( vertCount !== 0 ) {

			geometry.addGroup( groupOffset, vertCount, groupOrder[ i ].materialIndex );
			groupOffset += vertCount;

		}

	}

	// update the draw range
	geometry.setDrawRange( 0, drawRange );

	// remove the bounds tree if it exists because its now out of date
	// TODO: can we have this dispose in the same way that a brush does?
	// TODO: why are half edges and group indices not removed here?
	geometry.boundsTree = null;

	if ( needsDisposal ) {

		geometry.dispose();

	}

}

// Returns the list of materials used for the given set of groups
function getMaterialList( groups, materials ) {

	let result = materials;
	if ( ! Array.isArray( materials ) ) {

		result = [];
		groups.forEach( g => {

			result[ g.materialIndex ] = materials;

		} );

	}

	return result;

}

// Utility class for performing CSG operations
export class Evaluator {

	constructor() {

		this.triangleSplitter = new TriangleSplitter();
		this.attributeData = new TypedAttributeData();
		this.attributes = [ 'position', 'uv', 'normal' ];
		this.useGroups = true;
		this.debug = new OperationDebugData();

	}

	getGroupRanges( geometry ) {

		return ! this.useGroups || geometry.groups.length === 0 ?
			[ { start: 0, count: Infinity, materialIndex: 0 } ] :
			geometry.groups.map( group => ( { ...group } ) );

	}

	evaluate( a, b, operation, targetBrush = new Brush() ) {

		a.prepareGeometry();
		b.prepareGeometry();

		const targetGeometry = targetBrush.geometry;
		const {
			triangleSplitter,
			attributeData,
			attributes,
			useGroups,
			debug,
		} = this;

		prepareAttributesData( a.geometry, targetGeometry, attributeData, attributes );

		// run the operation to fill the list of attribute data
		// TODO: we can do this in more steps here and fill the data a second time for
		// the sibling geometry piece
		debug.init();
		performOperation( a, b, operation, triangleSplitter, attributeData, { useGroups } );
		debug.complete();

		// get the materials and group ranges
		const aGroups = this.getGroupRanges( a.geometry );
		const aMaterials = getMaterialList( aGroups, a.material );

		const bGroups = this.getGroupRanges( b.geometry );
		const bMaterials = getMaterialList( bGroups, b.material );
		bGroups.forEach( g => g.materialIndex += aMaterials.length );

		const groups = [ ...aGroups, ...bGroups ]
			.map( ( group, index ) => ( { ...group, index } ) );

		// generate the minimum set of materials needed for the list of groups and adjust the groups
		// if they're needed
		if ( useGroups ) {

			// create a map from old to new index and remove materials that aren't used
			const allMaterials = [ ...aMaterials, ...bMaterials ];
			const finalMaterials = [];
			for ( let i = 0, l = allMaterials.length; i < l; i ++ ) {

				let foundGroup = false;
				for ( let g = 0, lg = groups.length; g < lg; g ++ ) {

					const group = groups[ g ];
					if ( group.materialIndex === i ) {

						foundGroup = true;
						group.materialIndex = finalMaterials.length;

					}

				}

				if ( foundGroup ) {

					finalMaterials.push( allMaterials[ i ] );

				}

			}

			targetBrush.material = finalMaterials;

		} else {

			targetBrush.material = aMaterials[ 0 ];

		}

		// apply groups and attribute data to the geometry
		assignBufferData( targetGeometry, attributeData, groups );

		return targetBrush;

	}

	// TODO: fix
	evaluateHierarchy( root, target = new Brush() ) {

		root.updateMatrixWorld( true );

		const flatTraverse = ( obj, cb ) => {

			const children = obj.children;
			for ( let i = 0, l = children.length; i < l; i ++ ) {

				const child = children[ i ];
				if ( child.isOperationGroup ) {

					flatTraverse( child, cb );

				} else {

					cb( child );

				}

			}

		};


		const traverse = brush => {

			const children = brush.children;
			let didChange = false;
			for ( let i = 0, l = children.length; i < l; i ++ ) {

				const child = children[ i ];
				didChange = traverse( child ) || didChange;

			}

			const isDirty = brush.isDirty();
			if ( isDirty ) {

				brush.markUpdated();

			}

			if ( didChange && ! brush.isOperationGroup ) {

				let result;
				flatTraverse( brush, child => {

					if ( ! result ) {

						result = this.evaluate( brush, child, child.operation );

					} else {

						result = this.evaluate( result, child, child.operation );

					}

				} );

				brush._cachedGeometry = result.geometry;
				brush._cachedMaterials = result.material;
				return true;

			} else {

				return didChange || isDirty;

			}

		};

		traverse( root );

		target.geometry = root._cachedGeometry;
		target.material = root._cachedMaterials;

		return target;

	}

	reset() {

		this.triangleSplitter.reset();

	}

}
