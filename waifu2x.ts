import * as util from "util"
import * as fs from "fs"
import {imageSize} from "image-size"
import * as ffmpeg from "fluent-ffmpeg"
import {CancelablePromise} from "cancelable-promise"
import * as path from "path"
import * as child_process from "child_process"

const exec = util.promisify(child_process.exec)

export type Waifu2xFormats =
    | "bmp"
    | "dib"
    | "exr"
    | "hdr"
    | "jpe"
    | "jpeg"
    | "jpg"
    | "pbm"
    | "pgm"
    | "pic"
    | "png"
    | "pnm"
    | "ppm"
    | "pxm"
    | "ras"
    | "sr"
    | "tif"
    | "tiff"
    | "webp"

export interface Waifu2xOptions {
    noise?: 0 | 1 | 2 | 3
    scale?: number
    mode?: "noise" | "scale" | "noise-scale"
    blockSize?: number
    pngCompression?: number
    jpgWebpQuality?: number
    disableGPU?: boolean
    forceOpenCL?: boolean
    processor?: number
    threads?: number
    recursive?: boolean
    modelDir?: string
    rename?: string
    waifu2xPath?: string
    limit?: number
    parallelFrames?: number
}

export interface Waifu2xGIFOptions extends Waifu2xOptions {
    quality?: number
    speed?: number
    reverse?: boolean
    cumulative?: boolean
}

export interface Waifu2xVideoOptions extends Waifu2xOptions {
    framerate?: number
    quality?: number
    speed?: number
    reverse?: boolean
    ffmpegPath?: string
}

export default class Waifu2x {
    private static parseFilename = (source: string, dest: string, rename: string) => {
        let [image, folder] = ["", ""]
        if (!dest) {
            image = null
            folder = null
        } else if (path.basename(dest).includes(".")) {
            image = path.basename(dest)
            folder = dest.replace(image, "")
        } else {
            image = null
            folder = dest
        }
        if (!folder) folder = "./"
        if (folder.endsWith("/")) folder = folder.slice(0, -1)
        if (!image) {
            image = `${path.basename(source, path.extname(source))}${rename}${path.extname(source)}`
        }
        return {folder, image}
    }

    private static recursiveRename = (folder: string, fileNames: string[], rename: string) => {
        if (folder.endsWith("/")) folder = folder.slice(0, -1)
        for (let i = 0; i < fileNames.length; i++) {
            const fullPath = `${folder}/${fileNames[i]}`
            const check = fs.statSync(fullPath)
            if (check.isDirectory()) {
                const subFiles = fs.readdirSync(fullPath)
                Waifu2x.recursiveRename(fullPath, subFiles, rename)
            } else {
                const pathSplit = fileNames[i].split(".")
                const newName = pathSplit[0].split("_")[0] + rename
                const newPath = `${folder}/${newName}.${pathSplit.pop()}`
                fs.renameSync(fullPath, newPath)
            }
        }
    }

    public static parseDest = (source: string, dest?: string, options?: {rename?: string}) => {
        if (!options) options = {}
        if (!dest) dest = "./"
        if (options.rename === undefined) options.rename = "2x"
        let {folder, image} = Waifu2x.parseFilename(source, dest, options.rename)
        if (!path.isAbsolute(source) && !path.isAbsolute(dest)) {
            let local = __dirname.includes("node_modules") ? path.join(__dirname, "../../../") : path.join(__dirname, "..")
            folder = path.join(local, folder)
        }
        return path.normalize(`${folder}/${image}`)
    }

    private static timeout = async (ms: number) => {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    public static upscaleImage = async (source: string, dest?: string, options?: Waifu2xOptions, action?: () => "stop" | void) => {
        if (!options) options = {}
        if (!dest) dest = "./"
        if (options.rename === undefined) options.rename = "2x"
        let sourcePath = source
        let {folder, image} = Waifu2x.parseFilename(source, dest, options.rename)
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, {recursive: true})
        let local = __dirname.includes("node_modules") ? path.join(__dirname, "../../../") : path.join(__dirname, "..")
        if (!path.isAbsolute(source) && !path.isAbsolute(dest)) {
            sourcePath = path.join(local, source)
            folder = path.join(local, folder)
        }
        let destPath = `${folder}/${image}`
        const absolute = options.waifu2xPath ? options.waifu2xPath : path.join(__dirname, "../waifu2x")
        let program = `cd ${absolute}/ && waifu2x-converter-cpp.exe`
        let command = `${program} -i "${sourcePath}" -o "${destPath}" -s`
        if (options.noise) command += ` --noise-level ${options.noise}`
        if (options.scale) command +=  ` --scale-ratio ${options.scale}`
        if (options.mode) command += ` -m ${options.mode}`
        if (options.pngCompression) command += ` -c ${options.pngCompression}`
        if (options.jpgWebpQuality) command += ` -q ${options.jpgWebpQuality}`
        if (options.blockSize) command += ` --block-size ${options.blockSize}`
        if (options.disableGPU) command += ` --disable-gpu`
        if (options.forceOpenCL) command += ` --force-OpenCL`
        if (options.processor) command += ` -p ${options.processor}`
        if (options.threads) command += ` -j ${options.threads}`
        if (options.modelDir) {
            if (options.modelDir.endsWith("/")) options.modelDir = options.modelDir.slice(0, -1)
            if (!path.isAbsolute(options.modelDir)) options.modelDir = path.join(local, options.modelDir)
            command += ` --model-dir "${options.modelDir}"`
        }
        const child = child_process.exec(command)
        let stopped = false
        const poll = async () => {
            if (action() === "stop") {
                stopped = true
                child.stdio.forEach((s) => s.destroy())
                child.kill("SIGINT")
            }
            await Waifu2x.timeout(1000)
            if (!stopped) poll()
        }
        if (action) poll()
        await new Promise<void>((resolve) => {
            child.on("exit", () => {
                stopped = true
                resolve()
            })
        })
        return destPath as string
    }

    private static recursiveSearch = (dir: string) => {
        const files = fs.readdirSync(dir)
        let fileMap = files.map((file) => `${dir}/${file}`).filter((f) => fs.lstatSync(f).isFile())
        const dirMap = files.map((file) => `${dir}/${file}`).filter((f) => fs.lstatSync(f).isDirectory())
        for (let i = 0; i < dirMap.length; i++) {
            const search = Waifu2x.recursiveSearch(dirMap[i])
            fileMap = [...fileMap, ...search]
        }
        return fileMap
    }

    public static upscaleImages = async (sourceFolder: string, destFolder?: string, options?: Waifu2xOptions, progress?: (current: number, total: number) => void | boolean) => {
        if (!options) options = {}
        const files = fs.readdirSync(sourceFolder)
        if (sourceFolder.endsWith("/")) sourceFolder = sourceFolder.slice(0, -1)
        let fileMap = files.map((file) => `${sourceFolder}/${file}`).filter((f) => fs.lstatSync(f).isFile())
        const dirMap = files.map((file) => `${sourceFolder}/${file}`).filter((f) => fs.lstatSync(f).isDirectory())
        if (options.recursive) {
            for (let i = 0; i < dirMap.length; i++) {
                const search = Waifu2x.recursiveSearch(dirMap[i])
                fileMap = [...fileMap, ...search]
            }
        }
        if (!options.limit) options.limit = fileMap.length
        const retArray: string[] = []
        let cancel = false
        let counter = 1
        let total = fileMap.length
        let queue: string[][] = []
        if (!options.parallelFrames) options.parallelFrames = 1
        while (fileMap.length) queue.push(fileMap.splice(0, options.parallelFrames))
        if (progress) progress(0, total)
        for (let i = 0; i < queue.length; i++) {
            await Promise.all(queue[i].map(async (f) => {
                if (counter >= options.limit) cancel = true
                const ret = await Waifu2x.upscaleImage(f, destFolder, options)
                retArray.push(ret)
                const stop = progress ? progress(counter++, total) : false
                if (stop) cancel = true
            }))
            if (cancel) break
        }
        return retArray
    }

    private static encodeGIF = async (files: string[], delays: number[], dest: string, quality?: number) => {
        const GifEncoder = require("gif-encoder")
        const getPixels = require("get-pixels")
        if (!quality) quality = 10
        return new Promise<void>((resolve) => {
            const dimensions = imageSize(files[0])
            const gif = new GifEncoder(dimensions.width, dimensions.height)
            const file = fs.createWriteStream(dest)
            gif.pipe(file)
            gif.setQuality(quality)
            gif.setRepeat(0)
            gif.writeHeader()
            let counter = 0

            const addToGif = (frames: string[]) => {
                getPixels(frames[counter], function(err: Error, pixels: any) {
                    gif.setDelay(10 * delays[counter])
                    gif.addFrame(pixels.data)
                    gif.read()
                    if (counter >= frames.length - 1) {
                        gif.finish()
                    } else {
                        counter++
                        addToGif(files)
                    }
                })
            }
            addToGif(files)
            gif.on("end", () => {
                    resolve()
                })
            })
    }

    private static awaitStream = async (writeStream: NodeJS.WritableStream) => {
        return new Promise((resolve, reject) => {
            writeStream.on("finish", resolve)
            writeStream.on("error", reject)
        })
    }

    public static upscaleGIF = async (source: string, dest?: string, options?: Waifu2xGIFOptions, progress?: (current: number, total: number) => void | boolean) => {
        if (!options) options = {}
        if (!dest) dest = "./"
        const gifFrames = require("gif-frames")
        if (!options.cumulative) options.cumulative = false
        const frames = await gifFrames({url: source, frames: "all", cumulative: options.cumulative})
        let {folder, image} = Waifu2x.parseFilename(source, dest, "2x")
        if (!path.isAbsolute(source) && !path.isAbsolute(dest)) {
            let local = __dirname.includes("node_modules") ? path.join(__dirname, "../../../") : path.join(__dirname, "..")
            folder = path.join(local, folder)
        }
        const frameDest = `${folder}/${path.basename(source, path.extname(source))}Frames`
        if (fs.existsSync(frameDest)) Waifu2x.removeDirectory(frameDest)
        fs.mkdirSync(frameDest, {recursive: true})
        const constraint = options.speed > 1 ? frames.length / options.speed : frames.length
        let step = Math.ceil(frames.length / constraint)
        const frameArray: string[] = []
        let delayArray: number[] = []
        async function downloadFrames(frames: any) {
            const promiseArray = []
            for (let i = 0; i < frames.length; i += step) {
                const writeStream = fs.createWriteStream(`${frameDest}/frame${i}.jpg`)
                frames[i].getImage().pipe(writeStream)
                frameArray.push(`${frameDest}/frame${i}.jpg`)
                delayArray.push(frames[i].frameInfo.delay)
                promiseArray.push(Waifu2x.awaitStream(writeStream))
            }
            return Promise.all(promiseArray)
        }
        await downloadFrames(frames)
        if (options.speed < 1) delayArray = delayArray.map((n) => n / options.speed)
        const upScaleDest = `${frameDest}/upscaled`
        if (!fs.existsSync(upScaleDest)) fs.mkdirSync(upScaleDest, {recursive: true})
        options.rename = ""
        let scaledFrames: string[] = []
        if (options.scale !== 1) {
            let cancel = false
            let counter = 0
            let total = frameArray.length
            let queue: string[][] = []
            if (!options.parallelFrames) options.parallelFrames = 1
            while (frameArray.length) queue.push(frameArray.splice(0, options.parallelFrames))
            if (progress) progress(counter++, total)
            for (let i = 0; i < queue.length; i++) {
                await Promise.all(queue[i].map(async (f) => {
                    await Waifu2x.upscaleImage(f, `${upScaleDest}/${path.basename(f)}`, options)
                    scaledFrames.push(`${upScaleDest}/${path.basename(f)}`)
                    const stop = progress ? progress(counter++, total) : false
                    if (stop) cancel = true
                }))
                if (cancel) break
            }
        } else {
            scaledFrames = frameArray
        }
        if (options.reverse) {
            scaledFrames = scaledFrames.reverse()
            delayArray = delayArray.reverse()
        }
        await Waifu2x.encodeGIF(scaledFrames, delayArray, `${folder}/${image}`, options.quality)
        Waifu2x.removeDirectory(frameDest)
        return `${folder}/${image}`
    }

    public static upscaleGIFs = async (sourceFolder: string, destFolder?: string, options?: Waifu2xGIFOptions, totalProgress?: (current: number, total: number) => void | boolean, progress?: (current: number, total: number) => void | boolean) => {
        if (!options) options = {}
        const files = fs.readdirSync(sourceFolder)
        if (sourceFolder.endsWith("/")) sourceFolder = sourceFolder.slice(0, -1)
        const fileMap = files.map((file) => `${sourceFolder}/${file}`)
        if (!options.limit) options.limit = fileMap.length
        const retArray: string[] = []
        if (totalProgress) totalProgress(0, options.limit)
        for (let i = 0; i < options.limit; i++) {
            if (!fileMap[i]) break
            try {
                const ret = await Waifu2x.upscaleGIF(fileMap[i], destFolder, options, progress)
                const stop = totalProgress ? totalProgress(i + 1, options.limit) : false
                retArray.push(ret)
                if (stop) break
            } catch (err) {
                continue
            }
        }
        return retArray
    }

    public static parseFramerate = async (file: string, ffmpegPath?: string) => {
        let command = `${ffmpegPath ? ffmpegPath : "ffmpeg"} -i ${file}`
        const str = await exec(command).then((s: any) => s.stdout).catch((e: any) => e.stderr)
        return Number(str.match(/[0-9.]+ (?=fps,)/)[0])
    }

    public static parseDuration = async (file: string, ffmpegPath?: string) => {
        let command = `${ffmpegPath ? ffmpegPath : "ffmpeg"} -i ${file}`
        const str = await exec(command).then((s: any) => s.stdout).catch((e: any) => e.stderr)
        const tim =  str.match(/(?<=Duration: )(.*?)(?=,)/)[0].split(":").map((n: string) => Number(n))
        return (tim[0] * 60 * 60) + (tim[1] * 60) + tim[2]
    }

    public static parseResolution = async (file: string, ffmpegPath?: string) => {
        let command = `${ffmpegPath ? ffmpegPath : "ffmpeg"} -i ${file}`
        const str = await exec(command).then((s: any) => s.stdout).catch((e: any) => e.stderr)
        const dim = str.match(/(?<= )\d+x\d+(?= |,)/)[0].split("x")
        return {width: Number(dim[0]), height: Number(dim[1])}
    }

    public static upscaleVideo = async (source: string, dest?: string, options?: Waifu2xVideoOptions, progress?: (current: number, total: number) => void | boolean) => {
        if (!options) options = {}
        if (!dest) dest = "./"
        if (options.ffmpegPath) ffmpeg.setFfmpegPath(options.ffmpegPath)
        let {folder, image} = Waifu2x.parseFilename(source, dest, "2x")
        if (!path.isAbsolute(source) && !path.isAbsolute(dest)) {
            let local = __dirname.includes("node_modules") ? path.join(__dirname, "../../../") : path.join(__dirname, "..")
            folder = path.join(local, folder)
            source = path.join(local, source)
        }
        let duration = await Waifu2x.parseDuration(source, options.ffmpegPath)
        if (!options.framerate) options.framerate = await Waifu2x.parseFramerate(source, options.ffmpegPath)
        const frameDest = `${folder}/${path.basename(source, path.extname(source))}Frames`
        if (fs.existsSync(frameDest)) Waifu2x.removeDirectory(frameDest)
        fs.mkdirSync(frameDest, {recursive: true})
        let framerate = ["-r", `${options.framerate}`]
        let crf = options.quality ? ["-crf", `${options.quality}`] : ["-crf", "16"]
        let codec = ["-vcodec", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
        await new Promise<void>((resolve) => {
            ffmpeg(source).outputOptions([...framerate])
            .save(`${frameDest}/frame%d.png`)
            .on("end", () => resolve())
        })
        let audio = `${frameDest}/audio.mp3`
        await new Promise<void>((resolve, reject) => {
            ffmpeg(source).save(audio)
            .on("end", () => resolve())
            .on("error", () => reject())
        }).catch(() => audio = "")
        let upScaleDest = `${frameDest}/upscaled`
        if (!fs.existsSync(upScaleDest)) fs.mkdirSync(upScaleDest, {recursive: true})
        options.rename = ""
        let frameArray = fs.readdirSync(frameDest).map((f) => `${frameDest}/${f}`).filter((f) => path.extname(f) === ".png").sort(new Intl.Collator(undefined, {numeric: true, sensitivity: "base"}).compare)
        let scaledFrames: string[] = []
        if (options.scale !== 1) {
            let cancel = false
            let counter = 0
            let total = frameArray.length
            let queue: string[][] = []
            if (!options.parallelFrames) options.parallelFrames = 1
            while (frameArray.length) queue.push(frameArray.splice(0, options.parallelFrames))
            if (progress) progress(counter++, total)
            for (let i = 0; i < queue.length; i++) {
                await Promise.all(queue[i].map(async (f) => {
                    await Waifu2x.upscaleImage(f, `${upScaleDest}/${path.basename(f)}`, options)
                    scaledFrames.push(`${upScaleDest}/${path.basename(f)}`)
                    const stop = progress ? progress(counter++, total) : false
                    if (stop) cancel = true
                }))
                if (cancel) break
            }
        } else {
            scaledFrames = frameArray
            upScaleDest = frameDest
        }
        let tempDest = `${upScaleDest}/temp.mp4`
        let finalDest = `${folder}/${image}`
        let crop = "crop=trunc(iw/2)*2:trunc(ih/2)*2"
        if (!options.speed) options.speed = 1
        if (!options.reverse) options.reverse = false
        if (audio) {
            let filter: string[] = ["-vf", `${crop}`]
            await new Promise<void>((resolve) => {
                ffmpeg(`${upScaleDest}/frame%d.png`).input(audio).outputOptions([...framerate, ...codec, ...crf, ...filter])
                .save(`${upScaleDest}/${image}`)
                .on("end", () => resolve())
            })
            filter = ["-filter_complex", `[0:v]setpts=${1.0/options.speed}*PTS${options.reverse ? ",reverse": ""}[v];[0:a]atempo=${options.speed}${options.reverse ? ",areverse" : ""}[a]`, "-map", "[v]", "-map", "[a]"]
            await new Promise<void>((resolve) => {
                ffmpeg(`${upScaleDest}/${image}`).outputOptions([...framerate, ...codec, ...crf, ...filter])
                .save(tempDest)
                .on("end", () => resolve())
            })
        } else {
            let filter = ["-filter_complex", `[0:v]${crop},setpts=${1.0/options.speed}*PTS${options.reverse ? ",reverse": ""}[v]`, "-map", "[v]"]
            await new Promise<void>((resolve) => {
                ffmpeg(`${upScaleDest}/frame%d.png`).outputOptions([...framerate, ...codec, ...crf, ...filter])
                .save(tempDest)
                .on("end", () => resolve())
            })
        }
        let newDuration = await Waifu2x.parseDuration(tempDest)
        let factor = duration / options.speed / newDuration
        let filter = ["-filter_complex", `[0:v]setpts=${factor}*PTS[v]`, "-map", "[v]"]
        if (audio) filter = ["-filter_complex", `[0:v]setpts=${factor}*PTS[v];[0:a]atempo=1[a]`, "-map", "[v]", "-map", "[a]"]
        await new Promise<void>((resolve) => {
            ffmpeg(tempDest).outputOptions([...framerate, ...codec, ...crf, ...filter])
            .save(finalDest)
            .on("end", () => resolve())
        })
        Waifu2x.removeDirectory(frameDest)
        return finalDest
    }

    public static upscaleVideos = async (sourceFolder: string, destFolder?: string, options?: Waifu2xVideoOptions, totalProgress?: (current: number, total: number) => void | boolean, progress?: (current: number, total: number) => void | boolean) => {
        if (!options) options = {}
        const files = fs.readdirSync(sourceFolder)
        if (sourceFolder.endsWith("/")) sourceFolder = sourceFolder.slice(0, -1)
        const fileMap = files.map((file) => `${sourceFolder}/${file}`)
        if (!options.limit) options.limit = fileMap.length
        const retArray: string[] = []
        if (totalProgress) totalProgress(0, options.limit)
        for (let i = 0; i < options.limit; i++) {
            if (!fileMap[i]) break
            try {
                const ret = await Waifu2x.upscaleVideo(fileMap[i], destFolder, options, progress)
                const stop = totalProgress ? totalProgress(i + 1, options.limit) : false
                retArray.push(ret)
                if (stop) break
            } catch (err) {
                continue
            }
        }
        return retArray
    }

    private static removeDirectory = (dir: string) => {
        if (dir === "/" || dir === "./") return
        if (fs.existsSync(dir)) {
            fs.readdirSync(dir).forEach(function(entry) {
                const entryPath = path.join(dir, entry)
                if (fs.lstatSync(entryPath).isDirectory()) {
                    Waifu2x.removeDirectory(entryPath)
                } else {
                    fs.unlinkSync(entryPath)
                }
            })
            try {
                fs.rmdirSync(dir)
            } catch (e) {
                console.log(e)
            }
        }
    }
}

module.exports.default = Waifu2x
