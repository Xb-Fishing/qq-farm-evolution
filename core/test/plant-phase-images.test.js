const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getMutantDisplayPlantId,
    getMutantPlantImageByPhase,
    getPlantImageByPhase,
} = require('../src/config/gameConfig');
const catalog = require('../src/gameConfig/UpdateCatalog.json');
const reviewedStages = require('../src/gameConfig/plant_images/reviewed-resources.json');
const crypto = require('node:crypto');

test('六种已取证作物的土地阶段图命中真实资源，未补齐的十四种保留缺口', () => {
    const groups = new Map([[20107, 'Crop_107'], [20117, 'Crop_117'], [20119, 'Crop_119'],
        [20173, 'Crop_173'], [20125, 'Crop_125'], [20189, 'Crop_189']]);
    assert.equal(reviewedStages.resources.length, 30);
    for (const crop of catalog.crops) {
        const asset = groups.get(crop.seedId);
        assert.equal(getPlantImageByPhase(crop.plantId, 1), '/game-config/plant_images/common/seed.png');
        if (!asset) {
            assert.match(crop.imageStatus, /尚未取得/);
            for (let phase = 2; phase <= 6; phase += 1) assert.equal(getPlantImageByPhase(crop.plantId, phase), '/game-config/plant_images/common/seed.png');
            continue;
        }
        assert.doesNotMatch(crop.imageStatus, /尚未取得/);
        for (let phase = 2; phase <= 6; phase += 1) {
            const url = `/game-config/plant_images/${asset}/${phase}.png`;
            assert.equal(getPlantImageByPhase(crop.plantId, phase), url);
            assert.equal(getPlantImageByPhase(crop.seedId, phase), url);
            const file = path.join(__dirname, '..', 'src', url.replace('/game-config/', 'gameConfig/'));
            const proof = reviewedStages.resources.find(r => r.file === `${asset}/${phase}.png`);
            assert.ok(proof);
            assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), proof.sha256);
        }
    }
    assert.equal(catalog.crops.filter(c => !groups.has(c.seedId)).length, 14);
});

test('活动植物按阶段返回官方植物图片', () => {
    const image = getPlantImageByPhase(1021037, 6);
    assert.equal(image, '/game-config/plant_images/Crop_1037/6.png');
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', image.replace('/game-config/', 'gameConfig/'))), true);
});

test('2x2 Spine 活动植物可返回完整的静态阶段图', () => {
    assert.equal(getPlantImageByPhase(1029003, 1), '/game-config/plant_images/common/seed.png');
    for (let phase = 2; phase <= 7; phase += 1) {
        const image = getPlantImageByPhase(1029003, phase);
        assert.equal(image, `/game-config/plant_images/Crop_9003/${phase}.png`);
        assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', image.replace('/game-config/', 'gameConfig/'))), true);
    }
});

test('土地回包把活动种子 ID 当作 plant.id 时仍解析名称和官方阶段图', () => {
    assert.equal(getPlantImageByPhase(29003, 3), '/game-config/plant_images/Crop_9003/3.png');
    assert.equal(getMutantPlantImageByPhase(29003, [], 6), '/game-config/plant_images/Crop_9003/6.png');
});

test('未知活动作物没有专属阶段图时回退到游戏通用种子贴图', () => {
    assert.equal(getPlantImageByPhase(1999999, 4), '/game-config/plant_images/common/seed.png');
});

test('所有作物的土地种子阶段共用客户端通用种子贴图', () => {
    const seedImage = '/game-config/plant_images/common/seed.png';
    assert.equal(getPlantImageByPhase(1020128, 1), seedImage);
    assert.equal(getPlantImageByPhase(1026032, 1), seedImage);
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', seedImage.replace('/game-config/', 'gameConfig/'))), true);
});

test('变异植物映射优先选择完整组合', () => {
    assert.equal(getMutantDisplayPlantId(1029003, [5]), 1129003);
    assert.equal(getMutantDisplayPlantId(1029003, [11]), 1028003);
    assert.equal(getMutantDisplayPlantId(1029003, [5, 11]), 1128003);
    assert.equal(getMutantDisplayPlantId(1028003, [5, 11]), 1128003);
});

test('变异植物使用专属阶段图并在缺失时回退原作物', () => {
    assert.equal(
        getMutantPlantImageByPhase(1028003, [5, 11], 7),
        '/game-config/plant_images/Plant_1128003/7.png',
    );
    assert.equal(
        getMutantPlantImageByPhase(1029003, [5], 6),
        '/game-config/plant_images/Plant_1129003/6.png',
    );
});
